import { expect, test } from '@playwright/test';

import { expectDashboard, expectNoHorizontalScroll } from './app-flows';
import { authStateFile } from './seed-account';

/**
 * The tab *Organisationen* of the system administration — up to finding 16 a page
 * of its own under `/admin/superadmin` with its own entry in the header navigation
 * and its own `<h1>` („Superadmin-Übersicht").
 *
 * What is left of it: the list itself, under the `<h2>` „Organisationen
 * dieser Installation". The `<h1>` now belongs to the frame and is called
 * „Systemverwaltung" on all four tabs; the way here is the one header entry
 * „★ Systemverwaltung". The tab bar itself and the redirect of the old
 * address are measured by `system-settings.spec.ts`, not by this file.
 *
 * The routes behind this page, their 403 for a Tenant-Admin and the structural
 * watchman over „kein Pfadsegment trägt einen Tenant-Bezeichner" are covered by
 * `apps/api/test/admin/`. What only a browser can decide is what the page
 * *offers*: that the KPI tiles carry numbers rather than placeholders, that a
 * Organisation created here shows up in the table, and — the part a reviewer asked for
 * by name — that „Wechseln" and „Verwalten" appear **only** where the signed-in
 * person is a member, with a sentence instead of a greyed-out button
 * everywhere else.
 *
 * That last one is not cosmetic. `PUT /session/tenant` answers 404 for an organisation
 * the person is not in, deliberately the same answer an unknown id gets, and a
 * superadmin regularly *is* no member of a foreign Organisation — the flag opens
 * `GET /admin/tenants`, it is not a general key. Offered on
 * every row, the two buttons promised something the server refuses.
 *
 * **Desktop project only**, and it creates one organisation per run. That residue is
 * deliberate and named: there is no delete for an organisation yet, and the requirement's
 * „ein neu angelegter Organisation erscheint" cannot be shown without creating one.
 * The organisation's first admin is a **fresh** address on purpose — handing it to the
 * signed-in superadmin would give them a second membership, and their next
 * login would stop resolving an unambiguous active Organisation, which is what every
 * other spec of this suite depends on.
 */

test.use({ storageState: authStateFile });

/** The first tab of the system administration carries the bare address. */
const SUPERADMIN_PATH = '/admin/system';

/** The KPI tile of the overview, by the label under its number. */
const KPI_LABELS = [
  'Organisationen',
  'Formulare gesamt',
  'Antworten gesamt',
  'Nutzer gesamt',
] as const;

test.describe('Systemverwaltung · Organisationen', () => {
  test('zeigt die KPI-Kacheln, listet die Organisationen und bietet „Wechseln" nur mit Mitgliedschaft an', async ({
    page,
  }) => {
    await page.goto('/');
    await expectDashboard(page);

    // The way in, from the header — the entry exists because this person is a
    // superadmin, and it is the only thing that leads here without typing an
    // address.
    await page
      .getByRole('button', { name: 'Systemverwaltung', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Systemverwaltung', level: 1 }),
    ).toBeVisible();
    // And the tab that is actually open — the `<h1>` stands above all
    // four and on its own does not say where one has landed.
    await expect(
      page.getByRole('heading', {
        name: 'Organisationen dieser Installation',
        level: 2,
      }),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${SUPERADMIN_PATH}$`, 'u'));

    /*
      Narrowed to the tile row, and since finding 16 that is necessary rather
      than convenient: „Organisationen" is not only the first tile but also the
      tab above it — `page.getByText('Organisationen', { exact: true })` would find
      both and would break in strict mode.
    */
    const kpis = page.locator('.superadmin__kpis');
    for (const label of KPI_LABELS) {
      const tile = kpis.getByText(label, { exact: true });
      await expect(tile).toBeVisible();
      // The number next to the label, not just a label: a tile that lost its
      // value would still show the caption.
      await expect(
        tile.locator('xpath=preceding-sibling::*[1]'),
        `The KPI tile „${label}" carries no number.`,
      ).toHaveText(/^\d+$/u);
    }

    const table = page.getByRole('table');
    const ownRow = table
      .getByRole('row')
      .filter({ hasText: 'Dachorganisation' });
    const foreignRow = table
      .getByRole('row')
      .filter({ hasText: 'Ortsgruppe Musterstadt' });

    // Both seeded organisations are listed — the one cross-tenant query of the
    // application outside the worker and the purge.
    await expect(ownRow).toHaveCount(1);
    await expect(foreignRow).toHaveCount(1);

    // The session's own Organisation: it is the active one, so „Wechseln" is there and
    // says so, and „Verwalten" is offered.
    await expect(ownRow.getByRole('button', { name: '✓ Aktiv' })).toBeVisible();
    await expect(
      ownRow.getByRole('button', { name: 'Verwalten' }),
    ).toBeVisible();

    /*
     * The organisation this superadmin is **not** a member of. This is the assertion
     * the whole case exists for: a button here would promise a switch that
     * `PUT /session/tenant` refuses with 404, and the row used to advise
     * „bitte erneut versuchen" — wrong twice, because repeating cannot help.
     */
    await expect(
      foreignRow.getByText('Kein Mitglied in dieser Organisation'),
    ).toBeVisible();
    await expect(
      foreignRow.getByRole('button', { name: 'Wechseln' }),
    ).toHaveCount(0);
    await expect(
      foreignRow.getByRole('button', { name: 'Verwalten' }),
    ).toHaveCount(0);

    await expectNoHorizontalScroll(page, 'Systemverwaltung · Organisationen');
  });

  test('ein neu angelegter Organisation erscheint in der Tabelle — ohne Mitgliedschaft der Sitzung', async ({
    page,
  }) => {
    const stamp = Date.now().toString(36).toUpperCase().slice(-5);
    const shortName = `E2E${stamp}`;
    const name = `E2E-Organisation ${stamp}`;
    const adminEmail = `e2e-Organisation-${stamp.toLowerCase()}@e2e.example`;

    await page.goto(SUPERADMIN_PATH);
    await expect(
      page.getByRole('heading', {
        name: 'Organisationen dieser Installation',
        level: 2,
      }),
    ).toBeVisible();

    await expect(
      page.getByRole('row').filter({ hasText: shortName }),
      'The short name is stamped per run — a match before the organisation exists ' +
        'would mean this case is looking at somebody else’s row.',
    ).toHaveCount(0);

    await page.getByRole('button', { name: '+ Neue Organisation' }).click();
    const form = page.getByRole('form', { name: 'Neue Organisation' });
    await form.getByLabel('Kurzname').fill(shortName);
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('E-Mail des ersten Admins').fill(adminEmail);
    await form.getByLabel('Name des ersten Admins').fill(`Admin ${stamp}`);
    /*
     * **No password field any more** (ADR-0024): the first administrator gets
     * an invitation and sets it themselves. The form says so too — the sentence
     * below is the assurance that it says so *before* anybody clicks, and
     * not only afterwards.
     *
     * That a mail really comes about and that its link sets a password is
     * not the statement of this case (`tenant-admin.spec.ts` walks the path to
     * the end); here it is about the row in the table and about the
     * session being **no** member in the new Organisation.
     */
    await expect(
      form.getByText(
        'Diese Person bekommt eine Einladung per Mail und setzt ihr Passwort selbst.',
      ),
    ).toBeVisible();
    await expect(
      form.getByLabel('Passwort des ersten Admins'),
      'Ein Passwortfeld hier wäre der alte Weg — dann kennte jemand anderes ' +
        'das Passwort eines fremden Kontos.',
    ).toHaveCount(0);
    await form.getByRole('button', { name: 'Organisation anlegen' }).click();

    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toHaveCount(1);

    /*
     * The requirement's other half, seen from the outside: the first admin of the
     * new Organisation is the address typed above, **not** the superadmin who created
     * it. So this session has no membership there — and the row says so
     * instead of offering a switch that would be refused.
     */
    await expect(
      row.getByText('Kein Mitglied in dieser Organisation'),
    ).toBeVisible();
  });
});
