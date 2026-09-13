import { expect, test, type Locator } from '@playwright/test';
import type { A11yFixture } from './a11y/views';
import { A11Y_VIEWS } from './a11y/views';

import { buildFixtureForm, purgeFixtureForm } from './mobile/fixture';
import { authStateFile } from './seed-account';

/**
 * **What is operated gets clicked**  — every switch of every
 * view, with the finger, and the value afterwards is a different one than before.
 *
 * ## Why this is a case of its own and not a sentence in an instruction
 *
 * Playwright's `setChecked` **does not click** when the value is already right. A
 * case written that way runs green over a dead zone — exactly
 * that happened (`styles/switch.css` tells the fault, the counter-check
 * in `mobile-reachable.spec.ts` demonstrates it). "We always click now" is
 * an intention; this file is the measurement.
 *
 * ## The counting is the actual yield
 *
 * {@link SWITCHES_PER_VIEW} says how many switches every view carries. What
 * does **not** stand there must have zero switches — which is why a new
 * control in a view nobody thought of is a red case and
 * not a silent one. The same construction as the counting of `a11y-view-list.spec.ts`
 * against the router, for the same reason: a hand-tended list forgets
 * exactly what is new.
 *
 * ## What is **not** saved here
 *
 * Every switch is flipped over **and back** again, and no „Speichern" is
 * pressed. The views of this application hold the switch state until
 * then in the draft; the run therefore leaves nothing behind — not in the
 * organisation-wide and installation-wide rows either, about which `tenant-admin.spec.ts` and
 * `system-settings.spec.ts` run their own series runs.
 */

test.describe.configure({ mode: 'default' });

/**
 * How many `role="switch"` controls a view shows at 360 px.
 *
 * Measured on 2026-08-10 against the test form from `mobile/fixture.ts` (one
 * text question, published, „Angepasst" with saving in between and editing
 * after submitting). Views without an entry must have **zero**.
 *
 * The zeroes that surprise and therefore stand here:
 *
 * - The **Benachrichtigungen** show a switch only once a
 *   notification has been created — the test form has none.
 * - *tenant administration · **KI*** (ADR-0025) carries a `SelectSetting` and
 *   no switch, and that is a decision and no oversight: there are
 *   **three** answers (inherit, on, off), and a toggle would have made a fixed
 *   choice out of the inheriting in the moment of the first click
 *   (`TenantAiFields.tsx`). The tab *KI* of the **system** administration beside it
 *   has one — there the question is two-valued.
 * - The **assistant of an organisation** (`/admin/setup`) stands on
 *   step 1, and that one shows `TenantAppearanceCards`: logo selection as a
 *   `radiogroup`, colours as colour fields. The frame itself (`WizardFrame`)
 *   carries only controls. Steps 2 to 9 have switches — since
 *   ADR-0028 there are nine instead of eight, *Rechtstexte* stands before *KI* — but they are
 *   reachable from this address only via „Speichern und weiter",
 *   and their cards stand here anyway already under the tabs that show them
 *   permanently.
 * - The two **legal-text tabs** (`/admin/legal` and
 *   `/admin/system/legal`, ADR-0028) carry **zero** switches, and
 *   that has been looked up and not assumed: `LegalPageEditor` helps itself
 *   from three constructions, and none of them is a `ToggleSetting`. The choice
 *   „Vorlage ausfüllen ↔ Eigener Text" is a `role="radiogroup"` with two
 *   `<input type="radio">` — the same construction that
 *   `SettingsSectionCard` uses for „Tenant-Standard ↔ Angepasst"; „Welche
 *   Abschnitte gelten?" are bare `<input type="checkbox">` with a `<label>`
 *   and thereby `role="checkbox"`; the fields below them are `TextSetting`.
 *   `role="switch"` is awarded in this application exclusively by
 *   `ToggleSetting` (`views/settings/SettingsControls.tsx`), plus once each
 *   `FormMemberRow` and `QuestionProperties` — none of them stands on these
 *   tabs.
 *
 * ⚠️ Until 2026-08-17 a second one stood here: *tenant administration ·
 * Mailversand* was said to run its choice „System ↔ eigener Server" as a segmented control
 * with `role="radio"`. The choice has not existed since ADR-0023, and the
 * tab now carries a real switch — see the entry `tenant-mail`.
 * The counting thereby stood implicitly at 0 against 1 for one commit.
 *
 * ⚠️ The number hangs on the test form: a second question type or a different
 * access mode changes it. That is intended — it is a measurement of this
 * preparation and no claim about all forms.
 */
const SWITCHES_PER_VIEW: Readonly<Record<string, number>> = {
  /*
    Verfügbarkeit 3 (Anmeldefrist, Zeitlimit, Antwortlimit) + Zugriff &
    Sicherheit 3 (Passwortschutz, Zwischenspeichern, Bearbeiten nach Absenden)
    + Nach dem Absenden 1 (Weiterleiten) + Darstellung 3 = 10.

    **Eleven it was until 2026-08-14**: „Bestätigung an Teilnehmer senden" has
    fallen away without replacement (ADR-0011, continuation; finding 24). The switch was
    a second gate in front of the participant mail — whoever sets up a notification to the
    filling-in person has thereby decided that it goes out.
  */
  'form-settings': 10,
  'form-members': 1,
  'tenant-appearance': 1,
  /*
    The same sections **without Verfügbarkeit**: 3 + 1 + 3 = 7. The
    Verfügbarkeit stands only at the form (ADR-0011, continuation
    2026-08-14) — a deadline that an organisation prescribes to all its forms
    would close registrations nobody has looked at.

    Eleven stood here when the page still carried five cards and the
    participant switch that has fallen away.
  */
  'tenant-form-defaults': 7,
  /*
    **One, since the two mail servers are separated** (ADR-0023). Here once stood
    that this tab carried **zero** switches, because it ran its choice „System ↔
    eigener Server" as a segmented control with `role="radio"`. That choice does
    not exist any more: an organisation without its own mail server inherits nothing, its
    post waits — what remains is the switch „Mailserver eingerichtet".

    One and not three: „Implizites TLS" and „Anmeldung erforderlich" lie
    **inside** it, and `ToggleSetting` draws its children only in the
    switched-on state. The seeded state is „aus" (the seed enters
    no mail server per organisation), and counting happens before the first
    tap.
  */
  'tenant-mail': 1,
  /*
    **One entry instead of two** (finding 16). The system level once carried its
    mail server mask under two addresses — the bare
    `/verwaltung/systemeinstellungen` and its sub-path `/mailserver` —, and
    both sorts stood here with the same number. Today it is one tab of the
    system administration with one address.

    **Three, since `auth.setup.ts` enters the instance's mail server**
    (ADR-0024, measured in the first real CI run on 2026-08-18). They are the
    three `ToggleSetting` from `SystemMailCards.tsx`, inside one another:

    1. „Mailserver eingerichtet" (`draft.enabled`) — the outer one,
    2. „Implizites TLS (smtps)" (`draft.secure`) and
    3. „Anmeldung erforderlich" (`draft.authEnabled`) — both children of 1.

    It does not go deeper: the children of 3 are user name and password, that is
    text fields. `ToggleSetting` draws its children only in the switched-on
    state — here therefore stood **one** as long as the ground state was „aus".
    Since 2026-08-18 no account comes into being without an invitation and no invitation
    without the installation's mail server; `auth.setup.ts` therefore switches it
    on once for the whole run (reasoning there and in
    `e2e/instance-mail.ts`). The outer switch thereby stands **on**, and the
    two below it are drawn before the loop makes the first tap.

    ⚠️ The number hangs on this preparation and not on the tab: whoever removes the
    entry in `auth.setup.ts` gets 1 here again — and this
    case tells them, instead of silently operating two switches fewer.

    `system-tenants` and `system-monitoring` carry **zero** switches and
    therefore do not stand here: both are tables.
  */
  'system-mail': 3,
  /*
    **One, since the AI tab stands on the common construction** (ADR-0022,
    continuation 2026-08-18). Here once stood that it carried **zero** switches,
    because it "runs its choice as a select field" — that still holds for provider, model
    and region, but allowing the AI was always a
    checkbox. It is now a `ToggleSetting` like every other and thereby a
    `role="switch"`.
  */
  'system-ai': 1,
  /*
    **Three per template, and the seeded state has three templates** — the
    shipped ones. Per template: „Beim Absenden", „Bei nachträglicher Änderung"
    and „Geht an die ausfüllende Person".
  */
  'system-templates': 9,
};

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

/**
 * Flips a switch over with the **finger** and back again.
 *
 * `tap()` instead of `click()`, because this project runs `hasTouch: true` and the
 * finger is the operation at issue; `setChecked` is expressly
 * excluded (see the head). What is measured is the value **before** against the value
 * **after** — not "in the end it is on", which would also be true if never
 * anything had happened.
 */
async function expectToggles(control: Locator, where: string): Promise<void> {
  const before = await control.isChecked();

  await control.tap();
  await expect(
    control,
    `${where}: der Schalter stand auf ${String(before)} und muss nach einem ` +
      'Tipp auf seine Mitte den anderen Wert tragen. Tut er das nicht, liegt ' +
      'entweder etwas darüber oder der Tipp erreicht den ' +
      'Handler nicht.',
  ).toBeChecked({ checked: !before });

  await control.tap();
  await expect(
    control,
    `${where}: und zurück — dieser Lauf ändert nichts, er belegt nur, dass ` +
      'der Schalter in beide Richtungen schaltet.',
  ).toBeChecked({ checked: before });
}

test.describe('360 px – jeder Schalter schaltet um', () => {
  test.use({ storageState: authStateFile });

  for (const view of A11Y_VIEWS.filter((v) => v.audience === 'signed-in')) {
    test(view.name, async ({ page }) => {
      await view.open(page, fixture);

      const expected = SWITCHES_PER_VIEW[view.kind ?? ''] ?? 0;
      const switches = page.getByRole('switch');
      await expect(
        switches,
        `${view.name}: erwartet waren ${String(expected)} Schalter. Steht ` +
          'hier eine größere Zahl, gibt es einen Schalter, den kein Fall ' +
          'umschaltet — dann gehört er in `SWITCHES_PER_VIEW`, damit die ' +
          'Schleife unten ihn mitnimmt. Eine kleinere Zahl heißt, die Ansicht ' +
          'hat nicht vollständig geladen.',
      ).toHaveCount(expected);

      for (let index = 0; index < expected; index += 1) {
        const control = switches.nth(index);
        // Switched-off switches nobody can operate — they carry their
        // reason elsewhere (for instance „keine frühere Frage als Quelle").
        if (await control.isDisabled()) {
          continue;
        }
        await expectToggles(control, `${view.name}, Schalter ${String(index)}`);
      }
    });
  }
});
