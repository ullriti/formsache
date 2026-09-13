import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  expectNoHorizontalScroll,
  matchesDesktopMediaQuery,
  newForm,
  openFormSettings,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * Form settings.
 *
 * What only a real browser can show, and what this file is therefore for:
 * **„gesperrt, nicht nur blass"**. A unit test can assert that the client drops
 * a locked value before sending it; it cannot assert that the browser refuses
 * the interaction, and it cannot assert what the *stored* document looks like
 * afterwards. Both are done below, and the value is forced past the disabled
 * control on purpose — that is the attempt to see fail.
 *
 * **This file runs in both projects** (desktop 1280×800 and mobile 360×740, see
 * `playwright.config.ts`), which is what makes its single-column requirement a
 * measurement instead of a claim. It touches only forms it creates itself;
 * the write to the organisation's shared standards lives in `tenant-form-defaults.spec`
 * and runs on the desktop project alone.
 */

test.use({ storageState: authStateFile });

/**
 * A `datetime-local` value in `Europe/Berlin`, well clear of a transition.
 *
 * **And well clear of “today”.** The value stood at `2026-08-15T18:00` up to
 * this point — the day this file was last touched. The status strip reads the
 * deadline against the *current* clock, so the same case would have measured
 * „Geschlossen" on that same day from 18:00 onwards and would have gone red
 * without anything in the application having changed. A test date that hangs on
 * the calendar time of the run is not a fixed test quantity (`AGENTS.md`:
 * controlled time, no dependency on “today”).
 *
 * August, so that the time zone is reliably MESZ — the assertion on
 * „Zeitzone MESZ (Deutschland)" would be a different one in the winter half of
 * the year.
 */
const CLOSE_LOCAL = '2030-08-15T18:00';

/** The same date, as the interface writes it. */
const CLOSE_SHOWN = '15.08.2030, 18:00 Uhr MESZ';

/**
 * Opens the settings of a freshly created form and returns its title.
 *
 * Through the builder's own „Einstellungen" button rather than by typing the
 * address: it is the only way an editor reaches this page, so a run that
 * navigated around it would leave the entry point untested. The name carries no
 * „⚙" — the glyph is `aria-hidden`, so it is not part of the accessible name
 * (same rule as „Dashboard" in `shell-mobile.spec.ts`).
 */
async function newFormSettings(page: Page, base: string): Promise<string> {
  const title = await newForm(page, base);
  await openFormSettings(page);
  return title;
}

/** The card of one section, addressed by its heading. */
function sectionCard(page: Page, heading: string): Locator {
  return page.getByRole('region', { name: heading });
}

/** Sets one section to „Angepasst". */
async function customise(page: Page, heading: string): Promise<void> {
  await sectionCard(page, heading)
    .getByRole('radio', { name: 'Angepasst' })
    .check();
}

/** The save-state line — „Gespeichert" / „Nicht gespeichert". */
function saveState(page: Page): Locator {
  return page.getByText(/^(Gespeichert|Nicht gespeichert|Wird gespeichert…)$/);
}

/**
 * Presses „Speichern" and waits for the save to have **finished**.
 *
 * Waiting for the button to go disabled is not enough, and the difference
 * flaked roughly one run in four: the button is `disabled` on
 * `save.isPending || !dirty`, so it is already disabled the moment the request
 * *starts*. A test that typed straight afterwards was typing into an in-flight
 * save, and the answer — which is deliberately the new baseline
 * (`SettingsView`) — then overwrote what had just been typed. The state line
 * reading „Gespeichert" is the first signal that the answer has landed.
 *
 * The same window exists for a human who types during the request. It is
 * narrow and it is the documented design, but it is real; it is written down
 * as an open finding rather than papered over here.
 */
async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Speichern', exact: true }),
  ).toBeDisabled();
  await expect(saveState(page)).toHaveText('Gespeichert');
}

test.describe('Formular-Einstellungen', () => {
  test('shows the five sections, locks the inherited ones and stays in one column', async ({
    page,
  }) => {
    await newFormSettings(page, 'Einstellungen');

    for (const heading of [
      'Verfügbarkeit',
      'Zugriff & Sicherheit',
      'Nach dem Absenden',
      'Darstellung',
      'Versandbudget',
    ]) {
      await expect(sectionCard(page, heading)).toBeVisible();
    }

    /*
      Every *inheriting* section starts on „Tenant-Standard", so every one of
      them says so. **Four, not five** (ADR-0011, continuation 2026-08-14):
      *Verfügbarkeit* stands at the top as the fifth card and inherits from
      nobody, so it also carries no sentence about where its values would come
      from.

      The number is the actual yield: a sixth card that forgets the notice would
      otherwise not stand out — and neither would a *Verfügbarkeit* that got the
      inheritance switch back. The dedicated case further down measures the
      second of those once more from scratch.
    */
    await expect(page.getByText(/Standardwert vom Tenant/)).toHaveCount(4);

    // The status badge, out of the effective values — no deadline anywhere, so
    // the honest reading is „immer".
    await expect(page.getByText('Immer geöffnet')).toBeVisible();

    await expect(page.getByText('Vorschau Bestätigungsseite')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Tenant-Standards öffnen' }),
    ).toBeVisible();

    /*
      The effect no card shows by itself: taking a section over copies the
      organisation's current values into this form and cuts it off from the organisation's
      later changes. One mechanic, **all four inheriting** sections — hence the
      count, not a single lookup on the card where it hurts most.

      *Verfügbarkeit* does not carry the notice, and that is right: there is
      nothing to take over where nothing is inherited.
    */
    await expect(
      page.getByText(
        /spätere Änderungen der Organisation gelten für dieses Formular dann nicht mehr/,
      ),
    ).toHaveCount(4);

    // Only there the copied value is a secret — the access word — and the
    // notice says so.
    await expect(
      sectionCard(page, 'Zugriff & Sicherheit').getByText(
        /lässt dieses Formular weiter mit dem alten Wort herein/,
      ),
    ).toBeVisible();

    /*
      Two settings the handoff shows, and until recently neither existed here: one was
      postponed, one dropped outright. **By now that is no longer one statement
      but two.**

      *Zwischenspeichern erlauben* is there now — that is the requirement, and
      this case was the place that still carried the decision as open. It
      therefore checks it from here on in the other direction instead of being
      deleted: should the switch disappear again, it goes red.

      *Nur eine Antwort pro Person* stays absent, and permanently so — without
      participant accounts there is no person against whom this could be
      measured. Absent, not greyed out: a control without effect promises the
      feature all the same.
    */
    await expect(page.getByText(/Zwischenspeichern erlauben/)).toHaveCount(1);
    await expect(page.getByText(/Nur eine Antwort pro Person/)).toHaveCount(0);

    /*
      Playwright's `toBeDisabled` includes the enclosing `<fieldset>`, which is
      exactly the mechanism the lock uses. It is measured at
      *Nach dem Absenden* — a section that really does inherit.

      **Not at *Verfügbarkeit*:** that section is never locked today, because it
      inherits nothing; the assertion would therefore turn from “the locking
      mechanism takes hold” into “this section is locked” and would be red
      without anything being broken about the lock.
    */
    await expect(
      sectionCard(page, 'Nach dem Absenden').getByLabel(
        'Titel der Bestätigungsseite',
      ),
    ).toBeDisabled();

    await expectNoHorizontalScroll(page, 'Formular-Einstellungen');
  });

  /**
   * **The availability belongs to this form — and no organization can dictate
   * it to it** (ADR-0011, continuation 2026-08-14).
   *
   * An opening period, a deadline and a participant limit belong to *one* form;
   * dictated organization-wide they would close registrations nobody has looked
   * at. This promise has two halves, and both are measured here instead of
   * assumed:
   *
   * 1. On the form the card carries **no** inheritance switch — and its fields
   *    are operable all the same, without anything having to be “taken over”
   *    beforehand. The second half is the more important one: a card without a
   *    switch whose fields were locked would have made the setting unreachable
   *    instead of freeing it.
   * 2. In the organization the card does not exist at all — so there is **no
   *    way in the interface** by which an organization could prescribe it to a
   *    form. It is measured where it would have to exist: on the page that sets
   *    the organization's form standards.
   */
  test('die Verfügbarkeit hat keinen Vererbungsschalter, und die Organisation kann sie nicht vorgeben', async ({
    page,
  }) => {
    await newFormSettings(page, 'Verfügbarkeit gehört dem Formular');

    const availability = sectionCard(page, 'Verfügbarkeit');
    await expect(availability).toBeVisible();

    // --- neither side of the switch, and that within this card --------------
    // On `getByRole('radio')` inside the card, not on the page as a whole: the
    // four other cards still carry their switches, so a page-wide assertion
    // would be either wrong or vacuous.
    await expect(availability.getByRole('radio')).toHaveCount(0);

    /*
      And the half a mere absence does not evidence: the fields are **operable
      from the outset**. Without this assertion a card that has lost the switch
      and got stuck inside the locked `fieldset` would be just as green — and
      the setting would no longer be reachable for anybody.
    */
    const deadline = availability.getByRole('switch', {
      name: 'Anmeldefrist festlegen',
    });
    await expect(deadline).toBeEnabled();
    await deadline.click();
    await expect(deadline).toBeChecked();
    await expect(availability.getByLabel('Schließt am')).toBeEnabled();

    // --- and in the organization it does not exist -------------------------
    // Through the button an editor uses for it instead of typing the address:
    // that way it is also evidenced that the way there exists at all.
    await page.getByRole('button', { name: 'Tenant-Standards öffnen' }).click();
    await expect(
      page.getByRole('heading', { name: 'Formular-Standards' }),
    ).toBeVisible();

    await expect(
      page.getByRole('region', { name: 'Verfügbarkeit' }),
      'Die Organisation darf keinen Abschnitt „Verfügbarkeit" anbieten — ' +
        'sonst gäbe es doch einen Weg, einem Formular seine Frist vorzugeben.',
    ).toHaveCount(0);

    /*
      The counter-check to the absence: the page really has loaded and carries
      its four cards. Without it the assertion above would be green even if the
      page had never arrived — the failure case against which every
      “it is not there” measurement needs a positive control.
    */
    await expect(page.getByRole('region')).toHaveCount(4);
    for (const heading of [
      'Zugriff & Sicherheit',
      'Nach dem Absenden',
      'Darstellung',
      'Versandbudget',
    ]) {
      await expect(page.getByRole('region', { name: heading })).toBeVisible();
    }
  });

  /**
   * The deadline itself — **without a preceding „Angepasst"**.
   *
   * Until the continuation of ADR-0011 this case began by taking the section
   * over; that was the condition for the field becoming operable at all. The
   * condition is gone, and the case demonstrates that along the way: nothing is
   * unlocked here, there is only typing.
   */
  test('speichert eine Frist in der Zeitzone der Organisation, ohne dass der Abschnitt übernommen werden muss', async ({
    page,
  }) => {
    await newFormSettings(page, 'Frist');

    const availability = sectionCard(page, 'Verfügbarkeit');
    await expect(
      availability.getByRole('switch', { name: 'Anmeldefrist festlegen' }),
    ).toBeEnabled();

    await availability
      .getByRole('switch', { name: 'Anmeldefrist festlegen' })
      .check();
    await availability.getByLabel('Schließt am').fill(CLOSE_LOCAL);

    // The zone stands next to the field so nobody has to guess it.
    // Both fields report MESZ: the still-empty „Öffnet am" borrows the zone of
    // the filled one rather than reading today's clock, which is what makes
    // this assertion a fixed number instead of a seasonal one.
    await expect(
      availability.getByText('Zeitzone MESZ (Deutschland)'),
    ).toHaveCount(2);

    /*
      The badge follows the edit before it is saved — that is what „live" means.
      Below the breakpoint it carries the *short* label: the full sentence is
      wider than 360 px and the shell hides horizontal overflow, so it would be
      cut off rather than scrolled to. The date is not lost on mobile — it sits
      in the field itself, which the round-trip below asserts in both projects.
    */
    const onDesktop = await matchesDesktopMediaQuery(page);
    await expect(
      page.getByText(
        onDesktop ? `Geöffnet · bis ${CLOSE_SHOWN}` : /^Geöffnet$/,
      ),
    ).toBeVisible();

    await save(page);

    // Reloaded from the server: the instant that was stored comes back as the
    // same wall-clock time, which is the whole point of converting at the edge.
    await page.reload();
    await expect(
      sectionCard(page, 'Verfügbarkeit').getByLabel('Schließt am'),
    ).toHaveValue(CLOSE_LOCAL);
    if (onDesktop) {
      await expect(page.getByText(`bis ${CLOSE_SHOWN}`)).toBeVisible();
    }
  });

  /**
   * Clearing a deadline has to *stay* cleared (the `null` bug a review found).
   *
   * The failure it guards against was silent in the worst way: the field
   * snapped back to the old date, the badge kept announcing it, and the save
   * removed the deadline anyway. Screen and stored document said the opposite
   * of each other.
   */
  test('keeps an emptied deadline empty instead of snapping back', async ({
    page,
  }) => {
    await newFormSettings(page, 'Frist geleert');

    const availability = sectionCard(page, 'Verfügbarkeit');
    await availability
      .getByRole('switch', { name: 'Anmeldefrist festlegen' })
      .check();
    await availability.getByLabel('Schließt am').fill(CLOSE_LOCAL);
    await save(page);

    await availability.getByLabel('Schließt am').fill('');
    // Neither the field nor the badge may still carry the old date.
    await expect(availability.getByLabel('Schließt am')).toHaveValue('');
    await expect(page.getByText('15.08.2030', { exact: false })).toHaveCount(0);

    await save(page);
    await page.reload();
    await expect(
      sectionCard(page, 'Verfügbarkeit').getByLabel('Schließt am'),
    ).toHaveValue('');
  });

  /**
   * The control experiment for the test below.
   *
   * `forceInputValue` writes past React's value tracker; if it did not, the
   * next test would pass with no lock in place at all — the tracker would
   * swallow the write and nothing would ever reach the draft. This test is what
   * makes that impossible to overlook: here the write **must** arrive.
   */
  test('a forced value reaches the draft while the section is unlocked', async ({
    page,
  }) => {
    await newFormSettings(page, 'Kontrolle');
    await customise(page, 'Nach dem Absenden');

    const titleField = sectionCard(page, 'Nach dem Absenden').getByLabel(
      'Titel der Bestätigungsseite',
    );
    await expect(titleField).toBeEnabled();

    await forceInputValue(titleField, 'Erzwungen und angekommen');

    // Both halves: the value is in the field *and* the application recorded it.
    await expect(titleField).toHaveValue('Erzwungen und angekommen');
    await expect(saveState(page)).toHaveText('Nicht gespeichert');
  });

  /**
   * The other half, explicitly **not** checked optically: the attempt to
   * change a locked field must not change the stored document.
   */
  test('does not store a value forced into a locked field', async ({
    page,
  }) => {
    await newFormSettings(page, 'Gesperrt');

    // „Titel der Bestätigungsseite" rather than a field behind a switch: it is
    // rendered whatever the organisation's standard happens to say, so the test does
    // not depend on a setting somebody else may have changed.
    const confirmation = sectionCard(page, 'Nach dem Absenden');
    const titleField = confirmation.getByLabel('Titel der Bestätigungsseite');
    await expect(titleField).toBeDisabled();

    const forced = 'Von aussen erzwungen';
    await forceInputValue(titleField, forced);

    // The same write that arrives in the control test above records nothing
    // here — the section is locked, so there is nothing to save.
    await expect(saveState(page)).toHaveText('Gespeichert');

    /*
      A save needs something to save, so a *different* section is taken over.
      The forced value must not travel with it.

      „Darstellung" instead of „Verfügbarkeit": the availability no longer has
      an inheritance switch, so there is nothing to take over there
      (ADR-0011, continuation 2026-08-14). All that is needed here anyway is
      *some* inheriting section that arms the save button.
    */
    await customise(page, 'Darstellung');
    await save(page);

    await page.reload();
    const reloaded = sectionCard(page, 'Nach dem Absenden');
    // Still inherited: the section was never taken over, so the write left it
    // following the organisation — and the field shows the organisation's value, not the
    // forced one.
    await expect(reloaded.getByText(/Standardwert vom Tenant/)).toBeVisible();
    await expect(
      reloaded.getByLabel('Titel der Bestätigungsseite'),
    ).not.toHaveValue(forced);
  });
});

/**
 * Writes a value into an input **past** its disabled state and past React.
 *
 * React 19 attaches a *value tracker* to the node and replaces its `value`
 * setter; a plain `element.value = x` therefore runs through that tracker,
 * `updateValueIfChanged()` sees no change and `onChange` never fires. A review
 * caught exactly that here: the helper looked like it forced a value and in
 * truth wrote nothing the application could see, so the test it carries would
 * have been green with no lock at all. Calling the **prototype's** setter is
 * what gets underneath the tracker; the bubbling `input` event is what React
 * listens for. The control test above is the second half of that fix — it
 * proves the write arrives when nothing is supposed to stop it.
 *
 * The DOM members are declared inline because the tsconfig covering `e2e/` has
 * no `lib.dom` — same reasoning as in `app-flows.ts`.
 */
async function forceInputValue(locator: Locator, value: string): Promise<void> {
  await locator.evaluate((element, next: string) => {
    const node = element as unknown as {
      removeAttribute: (name: string) => void;
      value: string;
      dispatchEvent: (event: unknown) => boolean;
    };
    node.removeAttribute('disabled');

    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(node) as object,
      'value',
    );
    /*
      Taking the setter off the prototype *unbound* is the whole manoeuvre: it
      is `.call`ed with the node as receiver below, which is what gets
      underneath the instance-level setter React's value tracker installed.
    */
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const setter = descriptor?.set;
    if (setter === undefined) {
      // Loudly, not silently: a helper that quietly wrote nothing is the
      // failure this whole comment is about.
      throw new Error('The element has no prototype value setter to bypass.');
    }
    setter.call(node, next);

    const events = globalThis as unknown as {
      Event: new (type: string, init: { bubbles: boolean }) => unknown;
    };
    node.dispatchEvent(new events.Event('input', { bubbles: true }));
  }, value);
}
