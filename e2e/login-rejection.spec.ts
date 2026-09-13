import { expect, test, type Page } from '@playwright/test';

import {
  CREDENTIALS_MESSAGE,
  expectDashboard,
  expectLoginView,
  invitePersonAndSetPassword,
  mailQueueTestTimeout,
  submitLogin,
} from './app-flows';
import { authStateFile, seedAdmin, wrongPassword } from './seed-account';

/**
 * The other half of the login proof: the attempts that must **fail**.
 *
 * A test that only drives the successful path shows that a form can be filled
 * in, nothing more (`CONTRIBUTING.md`). What matters here is what stops
 * working: the wrong password, and — since the Profil-Ansicht arrived (findings
 * 12 and 17) — the session on a second device after its owner has changed the
 * password.
 *
 * Runs in one viewport only, on purpose: the forms and their error regions are
 * the same markup in both, and every extra attempt eats into the
 * ten-per-minute budget of `POST /api/auth/login`. The layout of both viewports
 * is covered by the `shell-*` specs.
 *
 * ## Why the profile cases stand in **this** file
 *
 * Not out of thematic proximity alone, but because `playwright.config.ts` assigns its
 * projects via an express alternation per project and a
 * *new* file would be caught there by nobody — `smoke-suite-coverage.spec.ts`
 * makes exactly that red, and rightly so. This file is assigned to the desktop project
 * **alone**, and for the cases below that is the condition and
 * not the convenience: they create a real account and log in
 * with it twice. In two projects at the same time those would be four logins
 * per run against the same budget of ten — and two runs quarrelling over the same
 * account.
 *
 * If these cases are ever to get a file of their own (`profile.spec.ts`
 * would be the more honest name), an entry in the `testMatch` of the
 * desktop project belongs with it — otherwise the file runs in zero projects and reports
 * green.
 */
test('weist ein falsches Passwort neutral ab, ohne Dashboard und ohne Sitzung', async ({
  page,
}) => {
  await page.goto('/');
  await expectLoginView(page);

  expect(
    await submitLogin(page, {
      email: seedAdmin.email,
      password: wrongPassword,
    }),
  ).toBe(401);

  // Exactly this wording, not merely "some error": anything that named the
  // e-mail address would turn the form into a directory of who has an account.
  await expect(page.getByRole('alert')).toHaveText(CREDENTIALS_MESSAGE);

  await expect(page.getByRole('heading', { name: 'Dashboard' })).toHaveCount(0);
  await expectLoginView(page);

  const session = await page.request.get('/api/auth/me');
  expect(session.status()).toBe(401);
});

/**
 * **Mein Profil** — changing one's own password, and what that does to the second
 * device (findings 12 and 17; ADR-0020).
 *
 * ## Why an account created specially
 *
 * Because this case **really changes** a password. If it did that with
 * `seedAdmin`, the damage would be permanent: the seed expressly does *not* reset an
 * existing password (`apps/api/prisma/seed.ts`), so
 * from the next run onwards every login of this suite would fail on a
 * password that only this one run knew — and `auth.setup.ts` would report it
 * as „vermutlich mit einem anderen SEED_ADMIN_PASSWORD geseedet". The account
 * here therefore comes into being during the run, carries its timestamp in the name and is
 * removed again at the end.
 *
 * ## What is measured
 *
 * Three statements, and the middle one is the one at issue:
 *
 * 1. Device B **is** really logged in beforehand. Without this positive control
 *    "B is dead" would also be green if the login had never worked.
 * 2. After the change on device A the session of device B is ended
 *    **server-side** — asked is `GET /api/auth/me` out of B's own context,
 *    not the view that B shows. A surface that falls back to the login mask
 *    while the token lives on would pass a mere
 *    visual check.
 * 3. Device A stays logged in — that is the promise standing on the card
 *    („Hier bleibst du angemeldet"), and it is the half that a
 *    "just log everything out" would accidentally have fulfilled as well.
 */
test('das eigene Passwort ändern beendet die Sitzung des zweiten Geräts, nicht die eigene', async ({
  browser,
}) => {
  /*
    **A time budget instead of Playwright's 30 s** — this case waits once for
    the mail queue (`invitePersonAndSetPassword`), and the worker runs
    on a 15-second beat. The calculation stands at `mailQueueTestTimeout`.
  */
  test.setTimeout(mailQueueTestTimeout(1));

  const stamp = Date.now().toString(36);
  const person = {
    name: `Profilperson ${stamp}`,
    email: `profil-${stamp}@example.invalid`,
    /** Both clearly above `USER_PASSWORD_MIN` (12). */
    password: `erstes-passwort-${stamp}`,
    nextPassword: `zweites-passwort-${stamp}`,
  } as const;

  // The superadmin creates the account — on the parked session, so without
  // a further login out of the budget.
  const adminContext = await browser.newContext({
    storageState: authStateFile,
  });
  const admin = await adminContext.newPage();

  const deviceAContext = await browser.newContext();
  const deviceA = await deviceAContext.newPage();
  const deviceBContext = await browser.newContext();
  const deviceB = await deviceBContext.newPage();

  /** `GET /api/auth/me` out of the context of this device. */
  async function sessionStatus(device: Page): Promise<number> {
    const response = await device.request.get('/api/auth/me');
    return response.status();
  }

  try {
    await admin.goto('/admin/members');
    /*
     * **No typed password any more** (ADR-0024): the block *Person
     * hinzufügen* has no field for it. The person gets an invitation,
     * opens the link and sets `person.password` themselves — the helper goes
     * exactly this way, over the instance's real catching server.
     *
     * `viewer` is the weakest of the three seed groups — this account is meant to
     * be able to do nothing except log in.
     */
    await invitePersonAndSetPassword(admin, browser, {
      name: person.name,
      email: person.email,
      password: person.password,
      role: 'viewer',
    });

    // --- two devices, two logins -----------------------------------------
    for (const device of [deviceA, deviceB]) {
      await device.goto('/');
      await expectLoginView(device);
      expect(
        await submitLogin(device, {
          email: person.email,
          password: person.password,
        }),
        'Das frisch angelegte Konto muss sich anmelden können — sonst misst ' +
          'alles Weitere nichts.',
      ).toBe(200);
      await expectDashboard(device);
    }

    // (1) The positive control: B **is** logged in before anything
    // happens.
    expect(await sessionStatus(deviceB)).toBe(200);

    // --- device A changes the password -----------------------------------
    await deviceA.goto('/profile');
    await expect(
      deviceA.getByRole('heading', { name: 'Mein Profil' }),
    ).toBeVisible();

    const passwordCard = deviceA.getByRole('region', {
      name: 'Passwort ändern',
    });
    await passwordCard.getByLabel('Aktuelles Passwort').fill(person.password);
    await passwordCard
      .getByLabel('Neues Passwort', { exact: true })
      .fill(person.nextPassword);
    await passwordCard
      .getByLabel('Neues Passwort wiederholen')
      .fill(person.nextPassword);
    await passwordCard.getByRole('button', { name: 'Passwort ändern' }).click();

    /*
      The message names the number of ended sessions **without one's own,
      just replaced one** — with two open logins therefore „1 weitere". Exactly
      this number is the proof that the change reached beyond this
      device; a mere „✓ geändert" would have stood there as well
      if only one's own session had been renewed.
    */
    await expect(
      passwordCard.getByRole('status'),
      'Die Bestätigung muss die eine weitere beendete Anmeldung benennen.',
    ).toHaveText(
      '✓ Dein Passwort wurde geändert; 1 weitere Anmeldung wurde beendet.',
    );

    // (2) And B is dead server-side — asked in its own context.
    await expect(async () => {
      expect(
        await sessionStatus(deviceB),
        'Nach einem Passwortwechsel muss die Sitzung des zweiten Geräts ' +
          'beendet sein. Antwortet sie noch mit 200, lebt der Token weiter ' +
          'und der Reflex „ich ändere mein Passwort" läuft ins Leere.',
      ).toBe(401);
    }).toPass();

    // …and the surface there falls back to the login. Both halves,
    // because the one without the other would each give the wrong safety.
    await deviceB.reload();
    await expectLoginView(deviceB);

    // (3) Device A stays where it is — the promise of the card.
    expect(
      await sessionStatus(deviceA),
      'Wer sein eigenes Passwort ändert, darf nicht selbst hinausfliegen — ' +
        'sonst läse niemand die Zahl, die die Antwort trägt.',
    ).toBe(200);
    await deviceA.goto('/');
    await expectDashboard(deviceA);
  } finally {
    /*
      Remove the account again. Best effort: a failed cleanup must not
      overwrite the finding above — what would remain is a `viewer` without
      rights, whose address carries the timestamp of this run.
    */
    try {
      await admin.goto('/admin/members');
      const row = admin.getByRole('listitem').filter({ hasText: person.email });
      await row
        .getByRole('button', { name: `${person.name} entfernen` })
        .click();
      /*
        `exact: true`: the accessible name of the „×" reads „<Person> entfernen"
        and thereby contains „Entfernen" — without `exact` the query would hit both
        buttons and click neither (the same trap as in
        `durchlauf-organisationen.spec.ts`).
      */
      await row.getByRole('button', { name: 'Entfernen', exact: true }).click();
      await expect(row).toHaveCount(0);
    } catch {
      // See above — deliberately swallowed.
    }
    await adminContext.close();
    await deviceAContext.close();
    await deviceBContext.close();
  }
});
