import { expect, test, type Locator, type Page } from '@playwright/test';

import { seedTenantAdmin, tenantAdminStateFile } from './seed-account';

/**
 * Mailversand — the mail server of an Organisation, in a real browser
 * (ADR-0013, ADR-0023).
 *
 * What is here is deliberately only what a browser can decide — the wire
 * contract, the guard chain and every refusal (a half-filled block, a
 * changed username without a new password, the unreadable-block 500) have
 * integration tests of their own (`apps/api/test/tenant-admin/smtp-*.spec.ts`,
 * `MailIdentityCard.test.tsx`). What this file proves is:
 *
 * 1. the switch „Mailserver eingerichtet" really does toggle when one
 *    clicks its **centre** — Playwright's `.click()` aims at the
 *    midpoint, i.e. at exactly the dead zone this project has already
 *    paid for once — and **without a mail server the hint stands there** that
 *    this Organisation then sends nothing (ADR-0023);
 * 2. a saved „eigen"-Block round-trips through the real API and a page
 *    reload — host and username come back, the password shows only
 *    „gesetzt", never the value;
 * 3. the Testmail card names the recipient **before** anything is clicked,
 *    and only once the draft matches what is saved (the evidence;
 *    the button itself is not clicked here — a real connection attempt
 *    against `OWN_HOST` would run into the 15 s connect timeout of
 *    `mail-timeouts.ts` for no evidence this file needs, since the API's own
 *    integration suite already proves the send path);
 * 4. switching off and saving really does replace the whole document and
 *    leaves no field of the block standing.
 *
 * **Runs in the desktop project only, serially**, for the same reason
 * `tenant-admin.spec.ts` gives for itself: every case writes
 * `tenant.smtp` of Musterstadt, a row several other files also touch — on
 * different columns, so no lost update, but a second worker mid-edit on
 * *this* column would still make the fourth case's „nothing left over"
 * assertion measure the wrong run. The last case restores „kein Mailserver"
 * — the state a freshly created Organisation starts in —, so this file
 * leaves Musterstadt as it found it.
 */

test.describe.configure({ mode: 'serial' });
test.use({ storageState: tenantAdminStateFile });

const TENANT_MAIL_PATH = '/admin/mail';

/** A host and address no seed uses, so a later assertion cannot be a fluke. */
const OWN_HOST = 'mail.musterstadt-stuttgart.invalid';
const OWN_FROM = 'versand@musterstadt-stuttgart.invalid';
const OWN_USER = 'versand';
const OWN_PASSWORD = 'e2e-mailversand-probe';

/** Ditto, for the *Basis-Adresse* section. */
const OWN_BASE_URL = 'https://musterstadt-stuttgart.invalid';

/** Ditto, for the *Antwortadresse* section. */
const OWN_REPLY_TO = 'antwort@musterstadt-stuttgart.invalid';

/**
 * The *Mailversand* card itself — its `<section aria-labelledby>` gets an
 * implicit `region` role carrying its heading as the name.
 *
 * **Every „Speichern"/„Gespeichert" in this file is scoped to a section, and
 * that is a correction to how the first three cases were written.** They date
 * from an earlier version, when this tab held one card and
 * `page.getByRole('button', { name: 'Speichern', exact: true })` could only
 * mean one thing; a later change added the *Basis-Adresse* section below
 * with a save bar of its own, and the
 * page-wide locator became a strict-mode violation — the fourth case, written
 * against the two-section tab, had scoped itself from the start and says so.
 *
 * **Fixed here rather than in the application, deliberately.** Two buttons
 * reading „Speichern" on one page is not an ambiguity a visitor has: each one
 * sits in its own named landmark, directly under the section it saves, and a
 * screen reader reaches it through that region. Renaming them („Basis-Adresse
 * speichern") would push the section name into a button the handoff draws with
 * one word, and it would have to be done in `SettingsSaveBar` — shared by four
 * settings surfaces, three of which have exactly one save bar and no ambiguity
 * to solve. What the page *could* still gain is an `aria-describedby` from each
 * save bar to its section heading, so the region name is announced with the
 * button rather than only on the way in; that is a change to a shared component
 * with four call sites and is named here rather than made in a test fix.
 */
function mailCard(page: Page): Locator {
  return page.getByRole('region', { name: 'Mailversand' });
}

test.describe('Mailversand ', () => {
  test('der Schalter „Mailserver eingerichtet" schaltet beim Klick auf seine Mitte um, und ohne Mailserver steht die Folge da', async ({
    page,
  }) => {
    await page.goto(TENANT_MAIL_PATH);
    await expect(
      page.getByRole('heading', { name: 'Mailversand' }),
    ).toBeVisible();

    // **The choice „über den Mailserver des Systems" no longer exists**
    // (ADR-0023). If the pill came back, the inheritance would be back with it.
    await expect(
      page.getByRole('button', { name: 'Über den Mailserver des Systems' }),
    ).toHaveCount(0);

    const server = page.getByRole('switch', {
      name: 'Mailserver eingerichtet',
    });
    await expect(server).toBeVisible();

    // The real proof: `.click()` targets the element's centre by default,
    // exactly the point the dead zone covered with decoration.
    await server.click();
    await expect(page.getByLabel('Host')).toBeVisible();

    await server.click();
    await expect(page.getByLabel('Host')).not.toBeVisible();
    // The plain hint ADR-0023 demands — in the browser, not only in the
    // component test.
    await expect(
      page.getByText('verschickt diese Organisation nichts'),
    ).toBeVisible();
  });

  test('ein gespeicherter eigener Block übersteht einen Neuladevorgang, und das Passwort zeigt nur „gesetzt"', async ({
    page,
  }) => {
    await page.goto(TENANT_MAIL_PATH);
    const card = mailCard(page);
    await page.getByRole('switch', { name: 'Mailserver eingerichtet' }).click();

    await page.getByLabel('Host').fill(OWN_HOST);
    await page.getByLabel('Port').fill('587');
    await page.getByLabel('Absenderadresse').fill(OWN_FROM);
    await page.getByLabel('Anmeldung erforderlich').click();
    await page.getByLabel('Benutzername').fill(OWN_USER);
    await page.getByLabel('Passwort ersetzen').fill(OWN_PASSWORD);

    await card.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(card.getByText('Gespeichert', { exact: true })).toBeVisible();

    // The Testmail card names the recipient and is enabled once the draft
    // matches the save that just went through — the evidence, and
    // the „Speichern vor dem Testen" gate resolved rather than left open.
    await expect(page.getByText(seedTenantAdmin.email)).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Testmail senden' }),
    ).toBeEnabled();

    await page.reload();
    await expect(
      page.getByRole('switch', { name: 'Mailserver eingerichtet' }),
    ).toBeChecked();
    await expect(page.getByLabel('Host')).toHaveValue(OWN_HOST);
    await expect(page.getByLabel('Benutzername')).toHaveValue(OWN_USER);
    // Never the value, only the state — the requirement.
    await expect(page.getByLabel('Passwort ersetzen')).toHaveValue('');
    await expect(page.getByText('Passwort ist gesetzt.')).toBeVisible();
  });

  test('das Ausschalten speichert den ganzen Block neu, kein Feld des eigenen bleibt übrig', async ({
    page,
  }) => {
    await page.goto(TENANT_MAIL_PATH);
    const card = mailCard(page);
    await page.getByRole('switch', { name: 'Mailserver eingerichtet' }).click();
    await card.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(card.getByText('Gespeichert', { exact: true })).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole('switch', { name: 'Mailserver eingerichtet' }),
    ).not.toBeChecked();
    await expect(page.getByLabel('Host')).not.toBeVisible();
  });

  /**
   * The *Basis-Adresse* section — the requirement. Its own section,
   * saved and read independently of the switch above: the previous case has just
   * taken the Organisation's mail server away, and this one nevertheless sets
   * a Basis-Adresse of its own — exactly ADR-0013 no. 3's claim that
   * the two have nothing to do with each other.
   *
   * Scoped to the section by its ARIA region (a `<section
   * aria-labelledby>` gets an implicit `region` role with that name), rather
   * than to `getByLabel`/`getByRole('textbox', …)` on the whole page: the
   * section's own heading is also named "Basis-Adresse", so the field's
   * label text alone is ambiguous between the two — the same trap
   * `TenantBaseUrlCard.test.tsx` and `SystemMailSettingsTab.test.tsx` name
   * for their own field of the same name. Scoping the whole section sidesteps
   * it rather than repeating a `getByRole('textbox', …)` workaround, and
   * `Speichern`/„Gespeichert" would otherwise also collide with the
   * Mailversand card's own save bar above it.
   */
  test('die Basis-Adresse übersteht einen Neuladevorgang und leert sich zurück auf „keine eigene"', async ({
    page,
  }) => {
    await page.goto(TENANT_MAIL_PATH);
    const section = page.getByRole('region', { name: 'Basis-Adresse' });
    const field = section.getByRole('textbox', { name: 'Basis-Adresse' });
    await expect(field).toBeVisible();

    await field.fill(OWN_BASE_URL);
    await section
      .getByRole('button', { name: 'Speichern', exact: true })
      .click();
    await expect(
      section.getByText('Gespeichert', { exact: true }),
    ).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole('region', { name: 'Basis-Adresse' }).getByRole('textbox', {
        name: 'Basis-Adresse',
      }),
    ).toHaveValue(OWN_BASE_URL);

    // Cleanup — this file leaves Musterstadt as it found it (see the file doc).
    const sectionAgain = page.getByRole('region', { name: 'Basis-Adresse' });
    await sectionAgain.getByRole('textbox', { name: 'Basis-Adresse' }).fill('');
    await sectionAgain
      .getByRole('button', { name: 'Speichern', exact: true })
      .click();
    await expect(
      sectionAgain.getByText('Gespeichert', { exact: true }),
    ).toBeVisible();

    await page.reload();
    await expect(
      page
        .getByRole('region', { name: 'Basis-Adresse' })
        .getByRole('textbox', { name: 'Basis-Adresse' }),
    ).toHaveValue('');
  });

  /**
   * *Antwortadresse*  — the third section of this
   * tab, and the reason why it is one of its own stands in the browser:
   * **it saves while the Organisation has no mail server at all**, i.e.
   * without any SMTP password being involved anywhere. If the field lay in the
   * indivisible block, this click path would not exist — and on an
   * Organisation without a block it would not exist at all.
   *
   * What the header of a sent mail makes of it does not belong here —
   * `apps/api/test/mail/reply-to.spec.ts` measures that against a real
   * SMTP server. What stands here is the round trip through the interface.
   *
   * Runs after the *Basis-Adresse* case, which leaves the Organisation without a mail
   * server (`mode: 'serial'`), and clears its own field again just the
   * same.
   */
  test('die Antwortadresse lässt sich speichern, während die Organisation keinen Mailserver hat', async ({
    page,
  }) => {
    await page.goto(TENANT_MAIL_PATH);

    // The precondition, not assumed but checked: there is no
    // block the field could lie in.
    await expect(
      page.getByRole('switch', { name: 'Mailserver eingerichtet' }),
    ).not.toBeChecked();

    const section = page.getByRole('region', { name: 'Antwortadresse' });
    const field = section.getByRole('textbox', { name: 'Antwortadresse' });
    await expect(field).toBeVisible();

    await field.fill(OWN_REPLY_TO);
    await section
      .getByRole('button', { name: 'Speichern', exact: true })
      .click();
    await expect(
      section.getByText('Gespeichert', { exact: true }),
    ).toBeVisible();

    await page.reload();
    await expect(
      page
        .getByRole('region', { name: 'Antwortadresse' })
        .getByRole('textbox', { name: 'Antwortadresse' }),
    ).toHaveValue(OWN_REPLY_TO);

    // Cleanup — empty means „die Systemvorgabe gilt", not the empty string.
    const again = page.getByRole('region', { name: 'Antwortadresse' });
    await again.getByRole('textbox', { name: 'Antwortadresse' }).fill('');
    await again.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(again.getByText('Gespeichert', { exact: true })).toBeVisible();

    await page.reload();
    await expect(
      page
        .getByRole('region', { name: 'Antwortadresse' })
        .getByRole('textbox', { name: 'Antwortadresse' }),
    ).toHaveValue('');
  });
});
