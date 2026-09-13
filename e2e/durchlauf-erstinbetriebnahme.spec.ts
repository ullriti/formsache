import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { webBaseUrl } from './env';

/**
 * **The first-run setup — the one state no other file reaches.**
 *
 * ## Why this run exists
 *
 * `global-setup.ts` migrates, **empties** and **seeds** before every run. After
 * that there are accounts, and `GET /api/setup` answers `setupRequired: false` —
 * the assistant from [ADR-0022](../docs/architecture/0022-erstinbetriebnahme.md)
 * is unreachable for the whole suite from that moment on. Until 2026-08-18 the
 * checklist of the axe run therefore held only **step 1**, and no case drove
 * the seven steps behind it — the third case below drives them
 * all by now.
 *
 * That was not negligence but a structure: the state
 * „this installation has no account yet" and the state in which every other
 * file works exclude one another.
 *
 * ## How this run produces it all the same — and why that is safe
 *
 * It **empties the database itself**, with exactly the script `global-setup`
 * runs at every run anyway (`reset-data`). Two properties make that
 * harmless, and both are promises of the project and not assumptions of this
 * file:
 *
 * 1. **`pnpm e2e` owns the database it points at** — spelled out in
 *    `docs/kb/04-build-run.md` and in the header of `apps/api/prisma/reset-data.ts`.
 * 2. **The next run seeds anew anyway.** Even if this run broke off in the
 *    middle of the assistant, `global-setup` restores the initial state
 *    again. The `afterAll` below does it immediately all the same — leaving a
 *    database in the assistant state would be a surprise for the next human,
 *    even if it does not break the next run.
 *
 * **No server restart needed**, and that is measured and not hoped:
 * `SetupService.state()` asks `user.findFirst` on **every** call, there is
 * no cache. Once the accounts are gone, the next page call shows
 * the assistant.
 *
 * ## Why it is a project of its own and runs strictly last
 *
 * Because the emptying invalidates **every** parked session. The project
 * therefore hangs on all the others (`dependencies` in `playwright.config.ts`) —
 * it only begins once nobody else wants anything from the database any more. The
 * same shape, for the same reason, as the three `durchlauf-*` projects before it.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Runs one of the two database scripts and lets its failure throw.
 *
 * **Word for word as `global-setup.ts`** — from the root, with `--filter`, not
 * out of `apps/api`. That is no formality: `global-setup` runs exactly
 * these calls before every run, so they are the proven ones. A second
 * spelling next to it would be a second way on which the same thing
 * can go wrong — and it would go wrong here, where nobody is looking, because
 * this project runs last and alone.
 */
function db(script: 'reset-data' | 'seed'): void {
  execFileSync('pnpm', ['--filter', '@formsache/api', 'run', script], {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

const SUPERADMIN = {
  name: 'Erste Betreiberin',
  email: 'erstinbetriebnahme@example.invalid',
  password: 'ein-hinreichend-langes-passwort',
} as const;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  // Without a session, without stored state: this run starts at
  // „this installation is empty".
  db('reset-data');
});

test.afterAll(() => {
  /*
    Back to the initial state — empty **and** seed, in this order
    and with the same two scripts as `global-setup`. Seeding alone would not
    be enough: by now the assistant has created an account and possibly an
    Organisation, and the seed lifts (`upsert`) instead of replacing.
  */
  db('reset-data');
  db('seed');
});

test.use({ storageState: { cookies: [], origins: [] } });

/**
 * **The assistant appears because there is no account** — and at every
 * step it says what does not work without it.
 *
 * The eight titles stand in `apps/web/src/views/setup/steps.ts`; they are
 * **not** copied out here but read one after another in the browser. A
 * list that stood here a second time would be the second truth that
 * departs from the first at some point.
 *
 * *Reproduction:* remove `reset-data` in the `beforeAll` → the sign-in mask
 * stands there and the first `expect` turns red.
 */
test('ohne Konto führt die Anwendung in den Assistenten, und Schritt 1 nennt seine Folge', async ({
  page,
}) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', { level: 1 }),
    'Ohne ein einziges Konto zeigt die Anwendung die Einrichtung und nicht ' +
      'die Anmeldung (ADR-0022 Nr. 1).',
  ).toBeVisible();

  await expect(page.getByText('Schritt 1 von 8')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Dein Zugang' }),
  ).toBeVisible();

  /*
    **Step 1 is the only one that may not be skipped** — without an
    account there is nobody who could do the remaining steps. Measured
    at the absence of the button, not at a disabled state:
    an „Überspringen" that is there and does nothing is an invitation.
  */
  await expect(
    page.getByRole('button', { name: 'Überspringen' }),
    'Schritt 1 darf kein „Überspringen" anbieten.',
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Zurück' }),
    'Und kein „Zurück" — dahinter liegt nichts.',
  ).toHaveCount(0);
});

/**
 * **The repetition of the password is a lock, not an ornament** (finding 5
 * of the second review round).
 *
 * Whoever mistypes here **does not get in at all any more**: there is nobody
 * who would let them in again, and „Passwort vergessen" needs a
 * mail server that does not yet exist at this moment. So what is measured is
 * that the button is **locked** on unequal inputs — and not
 * merely that a message appears afterwards.
 *
 * *Reproduction:* remove the lock in `AccessStep.tsx` → red.
 */
test('ungleiche Passwörter sperren den Weg weiter', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Schritt 1 von 8')).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill(SUPERADMIN.name);
  await page
    .getByLabel('E-Mail-Adresse', { exact: true })
    .fill(SUPERADMIN.email);
  await page.getByLabel('Passwort', { exact: true }).fill(SUPERADMIN.password);
  await page
    .getByLabel('Passwort wiederholen', { exact: true })
    .fill(`${SUPERADMIN.password}-vertippt`);

  const primary = page.getByRole('button', {
    name: 'Zugang anlegen und weiter',
  });
  await expect(
    primary,
    'Ein verschriebenes Passwort hier sperrt die Installation für immer aus ' +
      '— die Sperre ist die Zusage.',
  ).toBeDisabled();

  // And it releases as soon as the two are equal: a lock that never
  // opens would be a fault just the same.
  await page
    .getByLabel('Passwort wiederholen', { exact: true })
    .fill(SUPERADMIN.password);
  await expect(primary).toBeEnabled();
});

/**
 * **The assistant leads through what it announces** — eight steps, and at the
 * end stands „Eingerichtet".
 *
 * ## What this case held on to until 2026-08-18
 *
 * The finding: the assistant announced „Schritt 2 von 8" and was **no longer
 * reachable from step 3 on** — after „Überspringen" on step 2 the system
 * administration stood there. The case held that measured state fast,
 * so that the decision about it becomes visible instead of vanishing silently.
 *
 * It has been taken: **the assistant is made continuous.** It stays standing
 * until the end, even if after step 1 the installation formally already
 * **is** set up. What the finding really had was not the
 * setup question (`GET /api/setup` is asked exactly once per page call),
 * but the **session question**: step 3 brings along a second
 * observer of `GET /api/auth/me`, whose fresh answer carries the just
 * created superadministrator — and `App.tsx` thereupon swapped the
 * assistant for the signed-in shell. Re-measured and justified in
 * `apps/web/src/App.tsx` and in ADR-0022.
 *
 * ## What this case measures now
 *
 * 1. Step 1 creates the account. `POST /api/setup` expressly issues no
 *    session (ADR-0022); the step signs in immediately afterwards through
 *    the ordinary sign-in. That the assistant stands on step 2 is
 *    the evidence that both went through.
 * 2. The base address is **pre-filled** from the calling address and stays a
 *    field to confirm — behind a proxy in front, the address seen by the
 *    browser is not necessarily the one that belongs in mails. It is
 *    **saved** here and not skipped: that is at the same time the evidence that
 *    a signed-in system-settings route can be written to out of the
 *    assistant.
 * 3. **Every step after that can be skipped** — measured, not assumed:
 *    before every click stands the assurance that the button exists.
 *    `onSkip` is separate from `WizardStepMeta.skippable`, so a step can
 *    *be* skippable and still not offer the action.
 * 4. At the end stands the closing screen, and „Zur Anwendung" leads into the
 *    signed-in application — with a full reload, because after the
 *    setup every question of the browser is out of date.
 *
 * *Reproduction:* remove the lock `setupRunning ||` in `App.tsx` → this
 * case turns red on step 3, with the system administration in the snapshot.
 */
test('der Assistent führt von Schritt 1 bis zum Abschluss durch alle acht Schritte', async ({
  page,
}) => {
  await page.goto('/');

  const position = page.locator('.wizard__position');
  await expect(position).toHaveText('Schritt 1 von 8');

  await page.getByLabel('Name', { exact: true }).fill(SUPERADMIN.name);
  await page
    .getByLabel('E-Mail-Adresse', { exact: true })
    .fill(SUPERADMIN.email);
  await page.getByLabel('Passwort', { exact: true }).fill(SUPERADMIN.password);
  await page
    .getByLabel('Passwort wiederholen', { exact: true })
    .fill(SUPERADMIN.password);
  await page.getByRole('button', { name: 'Zugang anlegen und weiter' }).click();

  await expect(
    position,
    'Nach dem Anlegen steht der Assistent auf Schritt 2 — bleibt er auf 1, ' +
      'ist entweder das Anlegen gescheitert oder die Anmeldung danach.',
  ).toHaveText('Schritt 2 von 8');

  /*
    **The heading of the step, not that of the card inside it.**
    „Basis-Adresse" stands here twice, and that is the construction: the
    assistant reuses the *existing* settings cards (ADR-0025 no. 2).
    Resolved through the assurance `WizardFrame` gives itself —
    `id="wizard-step-<schlüssel>"`, the key stands in `steps.ts`. Not
    `.first()`: that would have covered up the ambiguity instead of naming it.
  */
  await expect(
    page.locator('h2#wizard-step-base-url'),
    'Die Überschrift des Schritts, nicht die der Karte darin.',
  ).toHaveText('Basis-Adresse');

  await expect(
    page.getByRole('textbox', { name: 'Basis-Adresse' }),
    'Vorbelegt aus der Aufruf-Adresse, nicht leer.',
  ).toHaveValue(webBaseUrl);

  /*
    Saved and not skipped: the first write on a signed-in route out of the
    assistant. It proves the session that step 1 established — a 401 would
    show up here as a refusal above the buttons, and the step would stay
    standing.
  */
  await page.getByRole('button', { name: 'Speichern und weiter' }).click();

  /*
    **The six steps after it, each via „Überspringen".**

    The titles stand in `apps/web/src/views/setup/steps.ts` and are not
    copied out here — what is measured is the position as text and the
    key the frame writes onto the heading. Before every click
    stands the assurance that the button exists at all: „every
    step except the first can be skipped" is a promise of the assistant
    (ADR-0022), and a promise one assumes instead of measuring is none.
  */
  const remaining = ['mail', 'addresses', 'templates', 'ai', 'legal', 'tenant'];
  for (const [offset, key] of remaining.entries()) {
    const step = offset + 3;
    await expect(position).toHaveText(`Schritt ${String(step)} von 8`);
    await expect(page.locator(`h2#wizard-step-${key}`)).toBeVisible();

    const skip = page.getByRole('button', { name: 'Überspringen' });
    await expect(
      skip,
      `Schritt ${String(step)} („${key}") muss „Überspringen" anbieten — der ` +
        'Assistent hält niemanden fest.',
    ).toHaveCount(1);
    await skip.click();
  }

  await expect(
    page.getByRole('heading', { level: 1, name: 'Eingerichtet' }),
    'Nach dem achten Schritt steht der Abschluss — der Assistent hält, was ' +
      'seine Zählung ankündigt.',
  ).toBeVisible();
  await expect(position).toHaveCount(0);

  /*
    And the transition: a full reload, because after the setup *everything*
    the browser knows about this installation is out of date. Measured at the
    signed-in shell — not at a heading of the system administration, which
    may change its wording.
  */
  await page.getByRole('button', { name: 'Zur Anwendung' }).click();

  await expect(
    page.getByRole('button', { name: 'Abmelden' }),
    'Nach dem Neuladen steht die angemeldete Anwendung — die Sitzung aus ' +
      'Schritt 1 trägt über den Assistenten hinaus.',
  ).toBeVisible();
  await expect(page.locator('.wizard__position')).toHaveCount(0);
});
