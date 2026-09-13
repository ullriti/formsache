import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  addQuestion,
  newForm,
  publishAndReadPath,
  saveForm,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * **What changes is announced** .
 *
 * Five assurances, one each for the five points to be proven: the
 * error message on submitting, the existing live regions, the progress
 * while filling in, the result of the AI dialog and the table row.
 *
 * **Plus the two remainders that the a11y pass named and deliberately left
 * open** — they needed a decision, and it fell on 2026-08-11
 * (the specification no. 92 and no. 93): the page change while filling in (announcement
 * **and** focus, sections 6 and 7) and the switch of the properties column,
 * whose whole effect lies in the hidden live preview (section 8).
 *
 * ## What is *not* measured here, and why that is the whole intention
 *
 * None of these assurances reads a class. `field--invalid`,
 * `public__page-progress-fill` and `ai-dialog__lead` are colour and layout —
 * a screen reader sees none of them. What is measured is therefore exclusively
 * what ends up in the accessibility tree:
 *
 * - the **accessible name** or the **accessible description** (`aria-
 *   describedby`, resolved down to the text of the referenced element),
 * - the **state** of a control (`aria-invalid`, `aria-valuetext`),
 * - and the **`role="status"` region** in which a change arrives.
 *
 * The reproduction here is exactly this distinction:
 * "remove the announcement from the state and leave only the colour". Each of
 * the five assurances below goes red from it; which line has to be pulled in
 * each case is written at the case.
 *
 * ## Why the desktop project
 *
 * Nothing here is a measurement across width: a live region has no
 * pixel size. The mobile half of the same paths is `mobile-paths.spec.ts`.
 */

test.describe.configure({ mode: 'default' });
test.use({ storageState: authStateFile });

const NAME_LABEL = 'Name des Mitglieds';

/**
 * The **accessible description** of a control, resolved.
 *
 * `aria-describedby` is a list of ids; what a screen reader reads out is
 * the text of the elements they point to. Both are gathered here
 * — the ids **and** their text —, so that a failed assurance can say
 * which of the two halves is missing: a reference into the void looks from
 * outside like no reference at all, but is a different fault.
 *
 * The attribute selector (`[id="…"]`) instead of `#id` is not taste: the ids
 * come from React's `useId` and carry characters (`«`, `»`, `:`) that a
 * CSS id selector would have to escape.
 */
async function accessibleDescription(
  page: Page,
  control: Locator,
): Promise<{
  readonly ids: readonly string[];
  readonly texts: readonly string[];
  readonly roles: readonly string[];
}> {
  const value = (await control.getAttribute('aria-describedby')) ?? '';
  const ids = value.split(/\s+/u).filter((entry) => entry !== '');

  const texts: string[] = [];
  const roles: string[] = [];
  for (const id of ids) {
    const target = page.locator(`[id="${id}"]`);
    if ((await target.count()) === 0) {
      texts.push('<kein Element mit dieser Id>');
      roles.push('<kein Element mit dieser Id>');
      continue;
    }
    texts.push(((await target.first().textContent()) ?? '').trim());
    roles.push((await target.first().getAttribute('role')) ?? '<ohne Rolle>');
  }

  return { ids, texts, roles };
}

/** Clears a form of this run away again — delete, then permanently. */
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

/** The form id from the builder's address. */
function formIdOf(page: Page): string | undefined {
  return /\/forms\/([^/?#]+)/u.exec(page.url())?.[1];
}

/* --- (1) The error message on submitting --------------------------------- */

test.describe('Fehlermeldung beim Absenden ', () => {
  /**
   * **The connection field ↔ message**, and not the red colour.
   *
   * What is measured is the chain a screen reader walks: the field reports
   * itself as invalid (`aria-invalid`), it points via `aria-describedby` to an
   * element, this element exists, its text **is** the message, and it
   * carries `role="alert"`, so that the message is announced when it appears.
   *
   * Without resolving the id the assurance would be a tautology: an
   * `aria-describedby="x-error"` pointing at nothing cannot be distinguished
   * from outside from a right one — and it reads as „das Feld hat eine
   * Beschreibung", while the user hears nothing.
   */
  test('das Feld zeigt auf seine Meldung, und dort steht sie auch', async ({
    page,
    browser,
  }) => {
    await newForm(page, 'Fehlermeldung angesagt');
    const formId = formIdOf(page);
    await addQuestion(page, 'Text', NAME_LABEL);
    await page.getByLabel('Pflichtfeld').check();
    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);
      const field = guest.getByLabel(new RegExp(NAME_LABEL, 'u'));

      // **Before submitting nothing is invalid** — otherwise everything below
      // would also be green for a field that always reports itself as broken.
      await expect(field).toHaveAttribute('aria-invalid', 'false');
      const before = await accessibleDescription(guest, field);
      expect(
        before.ids,
        'Ein unbeanstandetes Feld hat keine Fehlerbeschreibung.',
      ).toStrictEqual([]);

      await guest.getByRole('button', { name: 'Absenden' }).click();

      await expect(
        field,
        'Das leere Pflichtfeld muss sich selbst als fehlerhaft melden — die ' +
          'rote Umrandung sagt einem Screenreader nichts.',
      ).toHaveAttribute('aria-invalid', 'true');

      const after = await accessibleDescription(guest, field);
      expect(
        after.ids.length,
        'Das beanstandete Feld muss per aria-describedby auf seine Meldung ' +
          'zeigen. Ohne diese Verbindung steht die Meldung zwar auf dem ' +
          'Bildschirm, gehört aber zu keinem Feld.',
      ).toBe(1);
      expect(
        after.texts,
        'Der Text hinter der Referenz ist die Meldung selbst — nicht eine ' +
          'leere Hülle und nicht eine Id, die ins Leere zeigt.',
      ).toStrictEqual(['Pflichtfeld.']);
      expect(
        after.roles,
        'role="alert" ist das, was die Meldung beim Erscheinen ansagt. Ohne ' +
          'sie erfährt sie nur, wer zufällig wieder auf das Feld tabbt.',
      ).toStrictEqual(['alert']);
    } finally {
      await guestContext.close();
    }

    await purgeForm(page, formId);
  });
});

/* --- (2) The existing live regions --------------------------------------- */

test.describe('Vorhandene Live-Regionen ', () => {
  /**
   * **„Fassung n veröffentlicht" and the save state.**
   *
   * Both are `role="status"`, and both are searched for here *as a region*
   * (`getByRole('status')`), not as text. The difference is the whole
   * proof: `getByText('Gespeichert')` would stay green if the word stood in a
   * mute `<span>`.
   *
   * In addition the region is counted **before** the change. A
   * `role="status"` region that comes into being only together with its text is
   * frequently not announced at all — the `BuilderView` promises exactly that in its
   * own comment, and this line is the measurement for it.
   */
  test('Speicherzustand und Veröffentlichung stehen in Live-Regionen, die vorher schon da sind', async ({
    page,
  }) => {
    await newForm(page, 'Live-Regionen');
    const formId = formIdOf(page);
    await addQuestion(page, 'Text', NAME_LABEL);

    const statusRegions = page.getByRole('status');

    // The save state: „Nicht gespeichert" stands in a live region already
    // before the click.
    await expect(
      statusRegions.filter({ hasText: /^Nicht gespeichert$/u }),
      'Der Speicherzustand gehört in eine role="status"-Region.',
    ).toHaveCount(1);

    /*
      **The same region, before and after publishing.**

      Grabbed via the class name, and that is the one place of this
      file where that is permissible: what is asked is not *what* is displayed
      but whether **a** region is there before there is anything to say. The
      `BuilderView` promises in its own comment to render it unconditionally
      — "a role=status region that comes into being only together with its
      text is frequently not announced at all" —, and these three lines are
      the measurement for that promise. Via a role alone it could not be
      grabbed: the builder carries several `role="status"`, and the one sought
      differs before the first save from the others by nothing but its
      place.
    */
    const publishRegion = page.locator('.builder__publish-state');
    await expect(publishRegion).toHaveCount(1);
    await expect(
      publishRegion,
      'Die Region muss schon vor dem Veröffentlichen da sein — eine ' +
        'Live-Region, die zusammen mit ihrem Text entsteht, wird oft nicht ' +
        'angesagt.',
    ).toHaveAttribute('role', 'status');
    // The state before, verbatim: the unsaved draft. It is measured
    // along, so that the comparison below proves a **change** and
    // not merely an end state that perhaps existed all along.
    await expect(publishRegion).toHaveText(
      'Erst speichern, dann veröffentlichen',
    );

    await saveForm(page);
    await expect(
      statusRegions.filter({ hasText: /^Gespeichert$/u }),
    ).toHaveCount(1);

    await publishAndReadPath(page);

    await expect(
      publishRegion,
      'Nach dem Veröffentlichen steht die Fassung in derselben Live-Region.',
    ).toHaveText('Fassung 1 veröffentlicht');
    await expect(
      statusRegions.filter({ hasText: /Fassung 1 veröffentlicht/u }),
      'Und diese Region ist eine `role="status"` — über die Rolle gesucht, ' +
        'nicht über die Klasse.',
    ).toHaveCount(1);

    await purgeForm(page, formId);
  });
});

/* --- (3) The progress while filling in ----------------------------------- */

test.describe('Fortschritt beim Ausfüllen ', () => {
  /**
   * **The bar says its position, not only its width.**
   *
   * This assurance reproduces exactly that, verbatim: "remove the announcement
   * from the state and leave only the colour". The colour of the
   * progress bar is the filled area (`width: 50%`); the announcement are
   * `aria-valuenow` and `aria-valuetext`. **Both sides** are measured: the
   * value before and after „Weiter", so that a bar with a fixed `aria-valuetext`
   * — one that announces and lies while doing so — goes red here just like one without.
   */
  test('der Fortschrittsbalken meldet Seite 1 von 2 und danach Seite 2 von 2', async ({
    page,
    browser,
  }) => {
    await newForm(page, 'Fortschritt angesagt');
    const formId = formIdOf(page);
    await addQuestion(page, 'Text', NAME_LABEL);
    await page.getByRole('button', { name: '+ Seite hinzufügen' }).click();
    await addQuestion(page, 'Text', 'Bemerkung');
    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);

      const bar = guest.getByRole('progressbar');
      await expect(
        bar,
        'Ein zweiseitiges Formular zeigt den Fortschritt — die Vorgabe des ' +
          'Organisation hat den Balken an (`showProgress`).',
      ).toHaveCount(1);

      await expect(bar).toHaveAttribute('aria-valuenow', '1');
      await expect(bar).toHaveAttribute('aria-valuemax', '2');
      await expect(
        bar,
        'aria-valuetext ist das, was gesprochen wird — ohne es bleibt vom ' +
          'Balken nur die gefüllte Fläche.',
      ).toHaveAttribute('aria-valuetext', /Seite 1 von 2/u);

      await guest.getByRole('button', { name: 'Weiter' }).click();

      await expect(bar).toHaveAttribute('aria-valuenow', '2');
      await expect(
        bar,
        'Nach „Weiter" muss der angesagte Stand mitgehen. Ein fester Text ' +
          'wäre eine Ansage, die nicht stimmt.',
      ).toHaveAttribute('aria-valuetext', /Seite 2 von 2/u);
    } finally {
      await guestContext.close();
    }

    await purgeForm(page, formId);
  });
});

/* --- (4) The result of the AI dialog ------------------------------------- */

test.describe('Ergebnis des KI-Dialogs ', () => {
  /**
   * **The change „arbeitet" → „fertig".**
   *
   * This environment has no AI key, so the menu entry is rightly
   * missing (`mobile-paths.spec.ts` measures exactly that). The other situation
   * is produced by **the same pattern**: the real answer of
   * `GET /api/auth/me` is fetched and **one field** in it rewritten, and
   * the payload of `POST /api/ai/forms` carries as `definition` the **real**
   * definition of a form that this case built itself. With that
   * the hardest part of the dummy is schema-valid by construction.
   *
   * The answer is delivered **delayed**, and that is not a waiting time
   * in the test but the state at issue: without it „arbeitet" would never be
   * on the screen and the assurance about the change one about a
   * state that never existed. It is nevertheless waited on state, never on time —
   * the delay sits in the *dummy*, the assurances are
   * locator assurances.
   */
  test('„arbeitet" und „fertig" stehen beide in einer Live-Region', async ({
    page,
  }) => {
    await newForm(page, 'KI-Ansage');
    const formId = formIdOf(page);
    await addQuestion(page, 'Text', NAME_LABEL);
    await saveForm(page);

    const me = await page.request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    const session = (await me.json()) as Record<string, unknown>;
    const detail = await page.request.get(`/api/forms/${formId ?? ''}`);
    expect(detail.status()).toBe(200);
    const form = (await detail.json()) as Record<string, unknown>;

    await page.route('**/api/auth/me', async (route) => {
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

    /*
      The answer stays lying until this case releases it. A `setTimeout`
      would be a time span the test would have to hope for; a bolt is a
      state it opens itself.
    */
    let release = (): void => {
      /* is replaced below */
    };
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/ai/forms', async (route) => {
      await held;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          title: 'Bestandsmeldung',
          definition: form.definition,
          quota: { used: 3, limit: 50 },
        }),
      });
    });

    // On the dashboard, next to „+ Neues Formular" (finding 18) — no longer in
    // the header.
    await page.goto('/');
    await page.getByRole('button', { name: /KI-Formular/u }).click();

    const dialog = page.getByRole('dialog', {
      name: 'Formular mit KI erstellen',
    });
    await expect(dialog).toBeVisible();
    await dialog
      .getByLabel('Beschreibung des Formulars')
      .fill('Eine Bestandsmeldung mit Name und Anschrift.');
    await dialog.getByRole('button', { name: /Formular generieren/u }).click();

    // „arbeitet" — and in a live region at that, not merely on the screen.
    const working = dialog.getByRole('status').filter({
      hasText: /KI erstellt dein Formular/u,
    });
    await expect(
      working,
      'Die Arbeitsphase muss in einer role="status"-Region stehen; der ' +
        'kreisende Punkt daneben ist aria-hidden.',
    ).toHaveCount(1);

    release();

    /*
      **And „fertig".** That is the actual assurance:
      the change itself. A preview that only becomes *visible* is for a
      screen reader the end of the announcement „KI erstellt dein Formular…" and after that
      silence — the user goes on waiting for something that has long been there.
    */
    const done = dialog.getByRole('status').filter({
      hasText: /Vorschlag steht bereit/u,
    });
    await expect(
      done,
      'Nach der Arbeitsphase muss das Ergebnis angesagt werden — in einer ' +
        'Live-Region, mit dem Umfang des Vorschlags. Sonst endet die Ansage ' +
        'mit „arbeitet" und schweigt danach.',
    ).toHaveCount(1);
    await expect(done).toContainText('1 Seite');
    await expect(done).toContainText('1 Frage');

    // And the working phase is over — otherwise both announcements would stand at once.
    await expect(working).toHaveCount(0);

    // *Verwerfen* sends nothing and creates nothing.
    await dialog.getByRole('button', { name: 'Verwerfen' }).click();
    await expect(dialog).toHaveCount(0);

    await page.unroute('**/api/auth/me');
    await purgeForm(page, formId);
  });
});

/* --- (5) Adding and removing a table row --------------------------------- */

test.describe('Tabellenzeile ', () => {
  /**
   * **„+ Zeile" and „Entfernen" change the number of fields under the
   * cursor** — and that is exactly the sort of change that without an announcement only
   * whoever sees it notices.
   *
   * What is measured is the region **and its text**: the number of rows has to
   * stand in it. An announcement „Zeile hinzugefügt" without a count would be identical
   * for the second press on the same button to the first — and a live region
   * that twice receives the same text says nothing the second time.
   */
  test('Hinzufügen und Entfernen einer Zeile werden angesagt, mit der neuen Anzahl', async ({
    page,
    browser,
  }) => {
    await newForm(page, 'Tabellenzeile angesagt');
    const formId = formIdOf(page);
    await addQuestion(page, 'Tabelle', 'Teilnehmer');
    await page.getByLabel('Zeilen ergänzbar').check();
    await saveForm(page);
    const publicPath = await publishAndReadPath(page);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);

      const rows = guest.getByLabel(/^Spalte 1, Zeile /u);
      await expect(rows).toHaveCount(2);

      /*
        The region is there **before** the first press and empty — the same rule
        as with the publish state of the builder, and for the same
        reason. Grabbed via the `role="status"` region inside the
        question group: an empty region has no text by which one could otherwise
        find it.
      */
      const group = guest.getByRole('group', { name: /Teilnehmer/u });
      const announcement = group.getByRole('status');
      await expect(
        announcement,
        'Die Tabellenfrage braucht genau eine Live-Region für ihre Zeilen — ' +
          'und sie muss da sein, bevor die erste Zeile dazukommt.',
      ).toHaveCount(1);
      await expect(announcement).toBeEmpty();

      await guest.getByRole('button', { name: '+ Zeile' }).click();
      await expect(rows).toHaveCount(3);
      await expect(
        announcement,
        'Nach „+ Zeile" muss die Ansage die **neue Anzahl** nennen. Ohne sie ' +
          'ändert sich für einen Screenreader nichts Hörbares.',
      ).toHaveText(/Zeile 3 hinzugefügt, 3 Zeilen/u);

      await guest.getByRole('button', { name: 'Entfernen: Zeile 2' }).click();
      await expect(rows).toHaveCount(2);
      await expect(
        announcement,
        'Und das Entfernen ebenso — mit der Zeile, die ging, und dem, was ' +
          'übrig ist.',
      ).toHaveText(/Zeile 2 entfernt, 2 Zeilen/u);
    } finally {
      await guestContext.close();
    }

    await purgeForm(page, formId);
  });
});

/* --- (6) The page change while filling in: the announcement -------------- */

/**
 * Builds a two-page form with named pages and publishes it.
 *
 * The pages are **renamed**, and that is no cosmetics: with the defaults
 * „Seite 1"/„Seite 2" the heading of the second page would be called exactly like
 * half the progress line, and a failed assurance could not
 * say which of the two elements it means.
 */
async function twoNamedPages(page: Page): Promise<{
  readonly formId: string | undefined;
  readonly publicPath: string;
}> {
  const formId = formIdOf(page);
  await page.getByLabel('Titel von Seite 1').fill('Mitgliedschaft');
  await addQuestion(page, 'Text', NAME_LABEL);
  await page.getByRole('button', { name: '+ Seite hinzufügen' }).click();
  await page.getByLabel('Titel von Seite 2').fill('Verpflegung');
  await addQuestion(page, 'Text', 'Unverträglichkeiten');
  await saveForm(page);
  return { formId, publicPath: await publishAndReadPath(page) };
}

test.describe('Seitenwechsel beim Ausfüllen — die Ansage ', () => {
  /**
   * **`role="progressbar"` is no live region.**
   *
   * Section (3) above measures that the bar *carries* its position
   * (`aria-valuetext`) — and exactly that was the remainder: carried does not mean
   * spoken. Whoever presses „Weiter" heard nothing; the bar says its position
   * only to whoever moves onto it.
   *
   * What is measured is therefore the `role="status"` region and its text, **not**
   * `aria-valuetext` — otherwise this assurance would be a second version of (3)
   * and would stay green although nobody hears anything.
   *
   * The region is counted **before** the first press and proven to be empty:
   * the same rule as with the publish state of the builder and with the
   * table row — a live region that comes into being together with its text is
   * new in the accessibility tree when the text arrives, and is then frequently not
   * announced at all.
   */
  test('„Weiter" und „Zurück" landen beide in einer Live-Region, die vorher schon da ist', async ({
    page,
    browser,
  }) => {
    await newForm(page, 'Seitenwechsel angesagt');
    const { formId, publicPath } = await twoNamedPages(page);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);

      const announcement = guest.getByRole('status');
      await expect(
        announcement,
        'Der öffentliche Ausfüllweg braucht genau eine Live-Region für den ' +
          'Seitenwechsel — und sie muss da sein, bevor gewechselt wird.',
      ).toHaveCount(1);
      await expect(announcement).toBeEmpty();

      await guest.getByRole('button', { name: 'Weiter' }).click();
      await expect(
        announcement,
        'Nach „Weiter" muss der Wechsel gesprochen werden. Der Balken trägt ' +
          'seinen Stand zwar korrekt, sagt ihn aber nur dem, der ihn anfährt.',
      ).toHaveText('Seite 2 von 2 · Verpflegung');

      await guest.getByRole('button', { name: 'Zurück' }).click();
      await expect(
        announcement,
        '„Zurück" gehört genauso dazu — es ist derselbe Wechsel.',
      ).toHaveText('Seite 1 von 2 · Mitgliedschaft');

      /*
        **And the third step is the first sentence again.** That is the
        safeguard against the live-region pitfall: spoken is only what
        differs from its *predecessor*. The page number in the sentence is
        what separates every announcement from the one before it — an announcement „die Seite hat
        gewechselt" would be three times the same text and twice mute.
      */
      await guest.getByRole('button', { name: 'Weiter' }).click();
      await expect(announcement).toHaveText('Seite 2 von 2 · Verpflegung');
    } finally {
      await guestContext.close();
    }

    await purgeForm(page, formId);
  });
});

/* --- (7) The page change while filling in: the focus --------------------- */

test.describe('Seitenwechsel beim Ausfüllen — der Fokus ', () => {
  /**
   * **An assurance of its own, deliberately separated from (6).**
   *
   * The decision consists of two halves, and one line about both would be
   * too coarse: an implementation that only announces has to go red *here*, without
   * the announcement line going along. A message without a focus change lets the
   * operator know that something happened, and forces them to tab there
   * themselves — the focus would otherwise still stand on the button of the old page,
   * at the end of a document whose content was just exchanged above it.
   *
   * The focus is measured at the **element with the role**
   * (`heading`, level 2), not at a class: `public__page-title` is
   * font size, and a screen reader does not see it.
   */
  test('„Weiter" und „Zurück" setzen den Fokus auf die Überschrift der neuen Seite', async ({
    page,
    browser,
  }) => {
    await newForm(page, 'Seitenwechsel fokussiert');
    const { formId, publicPath } = await twoNamedPages(page);

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(publicPath);

      const first = guest.getByRole('heading', {
        name: 'Mitgliedschaft',
        level: 2,
      });
      const second = guest.getByRole('heading', {
        name: 'Verpflegung',
        level: 2,
      });

      // On opening **nothing** is focused: nothing has changed, and
      // a jump to the heading would displace the entry into the
      // form.
      await expect(first).not.toBeFocused();

      await guest.getByRole('button', { name: 'Weiter' }).click();
      await expect(
        second,
        'Ohne den Fokuswechsel steht der Bedienende weiter am „Weiter"-Knopf ' +
          'der alten Seite und muss sich selbst zum neuen Inhalt tabben.',
      ).toBeFocused();

      await guest.getByRole('button', { name: 'Zurück' }).click();
      await expect(first, 'Der Weg zurück ebenso.').toBeFocused();

      /*
        **And the heading stays out of the tab order.** `-1`
        instead of `0`: focusable on call, but no station nobody
        moved onto — on every page of every form.
      */
      await expect(first).toHaveAttribute('tabindex', '-1');
    } finally {
      await guestContext.close();
    }

    await purgeForm(page, formId);
  });
});

/* --- (8) The switch of the properties column ----------------------------- */

test.describe('Eigenschaften-Schalter ', () => {
  /**
   * **The live preview stays hidden, the change is announced.**
   *
   * `QuestionPreview` stands completely under `aria-hidden`, and that stays so:
   * it is a duplication of what the editor has just set, and
   * without `aria-hidden` a screen reader would read every question twice. The price for it
   * was that a switch whose whole effect lies *in* the preview had no
   * feedback — „Zeilen ergänzbar" is the reported case: one presses,
   * the box reports „aktiviert", and nothing says what that changed at the
   * question.
   *
   * What is measured is the `role="status"` region of the properties column and its
   * text — never the `checked` state of the box, which would stay green even
   * if the announcement disappeared without replacement.
   *
   * **Flipped twice**, because that is the pitfall: a live region that
   * twice receives the same text does not speak it the second time. That is why
   * the announcement carries its *value* — „ein"/„aus" alternate, so
   * every announcement differs from its predecessor.
   *
   * The container is grabbed via the class name, as already in section
   * (2): the builder carries several `role="status"` (save state,
   * publishing), and what is asked for is the one of the properties column.
   * What is measured is nevertheless the **role** in it, not the class.
   */
  test('„Zeilen ergänzbar" sagt seinen neuen Zustand an — beim zweiten Druck ebenso', async ({
    page,
  }) => {
    await newForm(page, 'Schalter angesagt');
    const formId = formIdOf(page);
    await addQuestion(page, 'Tabelle', 'Teilnehmer');

    const announcement = page.locator('.props').getByRole('status');
    await expect(
      announcement,
      'Die Eigenschaften-Spalte braucht genau eine Live-Region — und sie muss ' +
        'da sein, bevor der erste Schalter umgelegt wird.',
    ).toHaveCount(1);
    await expect(announcement).toBeEmpty();

    const box = page.getByLabel('Zeilen ergänzbar');

    await box.check();
    const on = (await announcement.textContent()) ?? '';
    expect(
      on,
      'Der Haken wirkt sich nur in der aria-hidden-Vorschau aus („+ Zeile"). ' +
        'Ohne Ansage hört der Bearbeiter nichts darüber, was er geändert hat.',
    ).toMatch(/^Zeilen ergänzbar: ein\. .+\d+ Zeilen\.$/u);

    await box.uncheck();
    const off = (await announcement.textContent()) ?? '';
    expect(off).toMatch(/^Zeilen ergänzbar: aus\. /u);
    expect(
      off,
      'Der zweite Druck muss einen **anderen** Satz erzeugen als der erste — ' +
        'sonst bleibt er stumm, und genau daran ist die erste Fassung dieser ' +
        'Ansage gescheitert.',
    ).not.toBe(on);

    await box.check();
    expect(
      (await announcement.textContent()) ?? '',
      'Und der dritte Druck unterscheidet sich wieder von seiner Vorgängerin.',
    ).not.toBe(off);

    await saveForm(page);
    await purgeForm(page, formId);
  });
});
