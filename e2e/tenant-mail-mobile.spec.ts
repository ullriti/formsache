import { expect, test } from '@playwright/test';

import { expectNoHorizontalScroll } from './app-flows';
import { tenantAdminStateFile } from './seed-account';

/**
 * Mailversand-Reiter at 360 px — the mobile half of the requirement.
 *
 * **Its own file, deliberately not `tenant-mail.spec.ts` itself added to the
 * `mobile-360x740` project.** That file runs `mode: 'serial'` and every case
 * writes `tenant.smtp` of Musterstadt — its own docblock explains why a second
 * worker mid-edit on that column would corrupt the final "nothing left over"
 * assertion. `fullyParallel` runs projects concurrently, so claiming that file
 * for the mobile project too would run its serial suite twice, at once,
 * against the very column it says must stay single-writer.
 *
 * **What is checked here needs no save at all**: the switch is the same
 * dead-zone proof that the first case of the desktop file carries — `.click()`
 * aims at the centre, `.check()`/`.setChecked()` do not — and it stays a
 * draft until „Speichern" is pressed, which this file never does. The
 * round trip across a reload, the test-mail gate and the case "saved without a
 * mail server" stay in `tenant-mail.spec.ts`, in the
 * desktop project.
 */

test.use({ storageState: tenantAdminStateFile });
test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

const TENANT_MAIL_PATH = '/admin/mail';

test.describe('Mailversand (360 px)', () => {
  test('der Schalter schaltet beim Klick auf seine Mitte um, und nichts ragt über den Viewport', async ({
    page,
  }) => {
    await page.goto(TENANT_MAIL_PATH);
    await expect(
      page.getByRole('heading', { name: 'Mailversand' }),
    ).toBeVisible();

    const server = page.getByRole('switch', {
      name: 'Mailserver eingerichtet',
    });
    await expect(server).toBeVisible();

    const hostField = page.getByLabel('Host');

    /*
     * The starting state is **read**, not assumed.
     *
     * A case whose first action cannot change anything does not show that
     * the switch reacts: the serial desktop suite in
     * `tenant-mail.spec.ts` leaves behind one state or the other depending on
     * which case ran last. It is read the way a person reads
     * it — is the SMTP block there? —, not off a CSS class
     * (`CONTRIBUTING.md`: selectors via role, label and text).
     */
    const startedOn = await hostField.isVisible();

    /*
     * Both states are measured, and the expanded one is the point:
     * host, port, encryption, sign-in and sender are the widest
     * content of this view.
     */
    const expectFits = async (on: boolean): Promise<void> => {
      if (on) {
        await expect(hostField).toBeVisible();
        await expectNoHorizontalScroll(
          page,
          'Mailversand (Mailserver eingerichtet, SMTP-Block aufgeklappt)',
        );
        return;
      }
      await expect(hostField).not.toBeVisible();
      // The notice that ADR-0023 demands has to fit at 360 px too — it
      // is the widest text that this state shows.
      await expect(
        page.getByText('verschickt diese Organisation nichts'),
      ).toBeVisible();
      await expectNoHorizontalScroll(page, 'Mailversand (kein Mailserver)');
    };

    await expectFits(startedOn);

    // `.click()` targets the centre — the dead zone this project has
    // paid for once already. The switch is clicked in both directions.
    await server.click();
    await expectFits(!startedOn);

    await server.click();
    await expectFits(startedOn);

    // No click ever reached „Speichern" — Musterstadt's stored block is
    // untouched and the draft ends where it began; that is exactly why this
    // file has to be neither serial nor desktop-only.
  });
});
