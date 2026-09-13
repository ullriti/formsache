import { expect, test } from '@playwright/test';

import { expectNoHorizontalScroll } from './app-flows';
import { authStateFile } from './seed-account';

/**
 * System administration → Mailserver at 360 px — the mobile half of the
 * requirement, and a view that until now had **no** dedicated E2E regression
 * coverage at all outside the opt-in `durchlauf-organisationen.spec.ts` walkthrough — the
 * rest is otherwise proven by `SystemMailSettingsTab.test.tsx` and the
 * API-level `apps/api/test/admin/system-mail-settings.spec.ts`.
 *
 * **Its own file, not folded into `system-settings.spec.ts`.** The reason was
 * that that case wrote the installation-wide `system_setting` row and
 * therefore ran serially and only in the desktop project. **That has not been
 * true since 2026-08-14**: with the form standards of the system level all
 * writing cases there have fallen away (ADR-0011, continuation; finding 9).
 *
 * The separation stays nonetheless, now for the reason that was the
 * load-bearing one anyway: `system-settings.spec.ts` is assigned to the desktop
 * project, and this case needs 360 px and a finger. Two files are the more
 * honest form here than one file with two viewports.
 *
 * **The load-bearing action needs no save.** Toggling „Mailserver eingerichtet"
 * only edits the draft the tab keeps in memory — nothing reaches
 * `system_setting` until „Speichern" is pressed, which this file never does —
 * so the round trip below is safe regardless of whatever `smtp` state a
 * parallel worker or an earlier acceptance-run walk left behind: it reads the
 * starting state rather than assuming one, and ends exactly where it started.
 */

test.use({ storageState: authStateFile });
test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

/**
 * The third tab of the system administration (finding 16).
 *
 * Hier stand einmal, die alte Adresse `/verwaltung/systemeinstellungen/mailserver`
 * leite hierher weiter und habe ihren eigenen Fall in `system-settings.spec.ts`.
 * Beides gilt nicht mehr: Review-Runde 4 Nr. 8 hat alle Pfade auf Englisch
 * gezogen und dabei den harten Schnitt gewählt — es gibt keine Weiterleitung
 * und keinen Fall dafür ([ADR-0030](../docs/architecture/0030-englische-url-pfade.md)).
 * Was bleibt, ist der Grund, warum hier die Adresse des Reiters selbst steht:
 * über eine fremde Adresse hereinzukommen hieße, den Weg statt den Reiter zu
 * messen.
 */
const SYSTEM_MAIL_SETTINGS_PATH = '/admin/system/mail';

test.describe('Systemverwaltung · Mailserver (360 px)', () => {
  test('der Schalter „Mailserver eingerichtet" reagiert auf einen Klick in seine Mitte', async ({
    page,
  }) => {
    await page.goto(SYSTEM_MAIL_SETTINGS_PATH);
    await expect(
      page.getByRole('heading', { name: 'Mailserver', exact: true }),
    ).toBeVisible();

    const toggle = page.getByRole('switch', {
      name: 'Mailserver eingerichtet',
      exact: true,
    });
    const startedEnabled = await toggle.isChecked();
    const hostField = page.getByLabel('Host');

    /*
     * Both states are measured, whichever one the installation happens to be
     * in — and the expanded one is the load-bearing half.
     *
     * The earlier version measured **once**, at the very end, after the switch
     * had been put back. Whenever that end state was „aus", the SMTP block —
     * Host, Port, Verschlüsselung, Anmeldung, Absender, the widest content this
     * view has — was not in the DOM at all, so the assertion measured the empty
     * card and called the view narrow enough. The state that can actually
     * overflow has to be the state that gets measured.
     */
    const expectFits = async (enabled: boolean): Promise<void> => {
      if (enabled) {
        await expect(hostField).toBeVisible();
        await expectNoHorizontalScroll(
          page,
          'Systemverwaltung · Mailserver (SMTP-Block aufgeklappt)',
        );
        return;
      }
      await expect(hostField).not.toBeVisible();
      await expectNoHorizontalScroll(
        page,
        'Systemverwaltung · Mailserver (Schalter aus)',
      );
    };

    await expectFits(startedEnabled);

    // The middle of the switch, not `.check()`/`.setChecked()` — the
    // dead zone this project has paid for once already.
    await toggle.click();
    await expectFits(!startedEnabled);

    // Back to where it started, still without a single „Speichern" — the
    // round trip proves the control works, not a change to the installation.
    await toggle.click();
    await expectFits(startedEnabled);
    await expect(toggle).toBeChecked({ checked: startedEnabled });
  });
});
