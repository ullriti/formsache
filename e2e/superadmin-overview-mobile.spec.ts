import { expect, test } from '@playwright/test';

import { expectNoHorizontalScroll } from './app-flows';
import { authStateFile } from './seed-account';

/**
 * The *Organisationen* tab of the system administration at 360 px — the mobile half
 * of the requirement. Up to finding 16 that was the own page
 * „Superadmin-Übersicht" under `/admin/superadmin`.
 *
 * **Its own file, deliberately not `superadmin-overview.spec.ts` itself added
 * to the `mobile-360x740` project — and the reason is residue, not sessions.**
 *
 * The reason this docblock gave until now was wrong, and saying so is cheaper
 * than leaving it: „Wechseln"/„Verwalten" re-scope the parked superadmin
 * session, so the desktop file must not run twice. But that file never
 * *clicks* either button — it asserts which row offers them and which row
 * carries „Kein Mitglied in dieser Organisation" instead. A constraint that does not
 * exist is worse than none, because the next reader believes it.
 *
 * The real one is countable. `superadmin-overview.spec.ts` creates one organisation per
 * run, deliberately and by its own docblock, because the requirement's „ein neu angelegter
 * Organisation erscheint" cannot be shown without one — and nothing can delete it
 * before the trash exists. Claiming that file for a second project would make
 * that **two** organisations per `pnpm e2e`. That is precisely the rate for which
 * `durchlauf-organisationen.spec.ts` was taken out of the default run: it degraded at roughly
 * seven accumulated organisations, i.e. after three or four runs, faster in CI with
 * `retries: 2`. A suite that rots a little with every push is the thing this
 * project already decided against once.
 *
 * **So this file creates nothing.** The load-bearing action is the dialog: „+
 * Neue Organisation" opens it, all five fields are filled — the widest state this
 * view has at 360 px — the measurement happens **while it is open**, and then
 * „Abbrechen" closes it. The evidence is the same (the view is operable and
 * fits at 360 px); the residue is zero, and the last assertion measures that
 * rather than promising it. Creating an organisation and reading its row back stays
 * where it belongs, in the desktop file, once per run.
 */

test.use({ storageState: authStateFile });
test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

/** The first tab of the system administration carries the bare address. */
const SUPERADMIN_PATH = '/admin/system';

test.describe('Systemverwaltung · Organisationen (360 px)', () => {
  test('„+ Neue Organisation" öffnet den Dialog, lässt sich ausfüllen und abbrechen, und nichts ragt über den Viewport', async ({
    page,
  }) => {
    await page.goto(SUPERADMIN_PATH);
    // The `<h1>` of the frame stands above all four tabs; which one is open is
    // only said by the `<h2>` beneath it.
    await expect(
      page.getByRole('heading', {
        name: 'Organisationen dieser Installation',
        level: 2,
      }),
    ).toBeVisible();

    await expectNoHorizontalScroll(
      page,
      'Systemverwaltung · Organisationen (Tabelle)',
    );

    /*
     * The full base-36 millisecond, not its last five digits.
     *
     * `Date.now().toString(36).slice(-5)` repeats every 36^5 ms ≈ 16.8 h, and
     * the pre-check below reads the table for exactly this string. Nothing is
     * written any more, so a repeat can no longer collide with the `@unique`
     * `tenant.short_name` — but it could still find yesterday's row and fail
     * this case for a reason that is not about this case. Eight characters cost
     * nothing against the schema's `max(32)`.
     */
    const stamp = Date.now().toString(36).toUpperCase();
    const shortName = `MOB${stamp}`;
    const name = `Mobil-Organisation ${stamp}`;

    const typedRow = page.getByRole('row').filter({ hasText: shortName });
    await expect(
      typedRow,
      'A match before anything was typed would mean this case is looking at ' +
        'somebody else’s row.',
    ).toHaveCount(0);

    await page.getByRole('button', { name: '+ Neue Organisation' }).click();
    const form = page.getByRole('form', { name: 'Neue Organisation' });
    await expect(form).toBeVisible();

    await form.getByLabel('Kurzname').fill(shortName);
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form
      .getByLabel('E-Mail des ersten Admins')
      .fill(`e2e-mobil-Organisation-${stamp.toLowerCase()}@e2e.example`);
    await form.getByLabel('Name des ersten Admins').fill(`Admin ${stamp}`);
    /*
     * **The fifth field is gone** (ADR-0024): „Passwort des ersten Admins"
     * no longer exists — the person gets an invitation and sets it
     * themselves. In its place stands a sentence that says so, and for the
     * measurement below that is the wider content: a body of running text in
     * 360 px is more of an overflow source than an input field.
     */
    await expect(form.getByLabel('Passwort des ersten Admins')).toHaveCount(0);
    await expect(
      form.getByText(
        'Diese Person bekommt eine Einladung per Mail und setzt ihr Passwort selbst.',
      ),
    ).toBeVisible();

    // Measured with the dialog open and filled — four labelled fields, the
    // note that replaced the fifth, their error slots and the two action
    // buttons, stacked into 360 px. This is the widest this view gets; the
    // table behind it was measured above.
    await expectNoHorizontalScroll(
      page,
      'Systemverwaltung · Organisationen (Dialog „Neue Organisation" offen und ausgefüllt)',
    );

    /*
     * The footer button, found by its name alone. It used to need a filter on
     * the visible text, because the „×" in the dialog head announced itself as
     * „Abbrechen" too and the role query was a strict-mode violation — which is
     * how that was found. The head button now says what it closes, so the
     * ambiguity is gone at the source rather than worked around here.
     */
    await form.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(
      form,
      '„Abbrechen" has to close the dialog — a form left standing would mean ' +
        'this case merely refrained from pressing submit rather than declining ' +
        'to create anything.',
    ).toHaveCount(0);

    /*
     * The zero-residue assertion, and the reason this file may run on every
     * push: what was typed above reached no table row and therefore no `tenant`
     * row. Without it, „wir legen nichts an" would be a claim in a comment.
     */
    await expect(typedRow).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(
      0,
    );
  });
});
