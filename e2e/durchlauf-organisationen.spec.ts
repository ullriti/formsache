import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

import {
  INSTANCE_MAIL_FROM,
  addQuestion,
  confirmPublishNotice,
  configureInstanceMailServer,
  expectDashboard,
  expectSaved,
  expectLoginView,
  newForm,
  publishAndReadPath,
  redeemInvitation,
  saveForm,
  submitLogin,
  waitForInvitationLink,
} from './app-flows';
import { startFakeIdp, type FakeIdp } from '@formsache/test-idp';

import { webBaseUrl } from './env';
import { instanceMailPort } from './instance-mail';
import { authStateFile, seedAdmin } from './seed-account';
import { startSmtpCatcher, type SmtpCatcher } from './smtp-catcher';

/**
 * **The overall run: several organisations work separately and securely.**
 *
 * Not a unit of the suite's coverage but this file's own acceptance run,
 * written as a Playwright script for the reason earlier acceptance runs
 * were driven by a browser at all: every step goes **over the
 * surface**, with the clicks a person makes. Nothing here writes SQL, seeds a
 * fixture or reaches into a JSONB column — a run that succeeds because its hard
 * parts were left out does not satisfy the requirement.
 *
 * The database is **read** to corroborate (through the application's own API,
 * under the session that is signed in), never written to manufacture a state.
 *
 * ## What the run leaves behind, and what it puts back
 *
 * **Cleanup.** It creates **two organisations per run**, and there is a
 * way to delete one: `DELETE /api/admin/tenants/:id`, reached the
 * same way `superadmin-deleted-tenants.spec.ts` proves it in isolation — through
 * the „Löschen" control of the organisation overview of the system administration, with the organisation's own name
 * typed as confirmation. That undoes the residue this file used to leave behind
 * on every run (measured: two organisations per pass, the suite started failing at
 * roughly seven accumulated) and is the reason it can live in `pnpm e2e` again.
 *
 * **The cleanup is `afterAll`, not a case of its own.** A case at the end of a
 * `mode: 'serial'` file never runs once an earlier one fails — Playwright skips
 * the rest of a failed serial group — and that is exactly backwards for a file
 * whose whole purpose here is to leave nothing behind: the run that broke is the
 * one that most needs its cleanup to still happen. `afterAll` runs regardless.
 * Each of its steps is its own `try`/`catch` (logged, not swallowed into
 * silence) so a broken system-settings restore does not stop the tenant
 * deletions, and a failed deletion of one organisation does not stop the attempt on the
 * other; a `finally` around the whole thing keeps the contexts, the two SMTP
 * catchers and the fake IdP closing even if every step above threw.
 *
 * **Soft-deleted, and counted accordingly.** „Löschen" puts an organisation in the
 * trash; its row stays until the 30-day purge
 * removes it physically. What this run can therefore assert is „die Zahl der
 * **lebenden** Organisationen ist danach dieselbe wie davor", measured on
 * `GET /admin/tenants`' `totals.tenants` — the live count, which is also
 * filtered on (`deletedAt: null`) and therefore the same number the
 * organisation overview of the system administration itself shows and every other spec would see. A
 * deleted organisation still exists as a row; it just stops being one of the organisations
 * anybody — this file, an operator, another spec — counts as installed.
 *
 * **Counted after a real run, not assumed** (an earlier review): a finished
 * `pnpm e2e` leaves `{ live: 3, trashed: 2 }` in `tenant` — the seed's two
 * Organisationen plus the one `superadmin-overview.spec.ts` creates and nothing
 * deletes, and this file's two in the trash. The table therefore grows by
 * three rows per run, and that is deliberate rather than the residue this
 * cleanup was built against: `global-setup.ts` truncates every table before
 * each run, so nothing accumulates across runs here, and in a real
 * installation the purge takes the deleted Organisationen out physically 30 days
 * later. What must not grow is the **live** count — that is what the
 * assertion below confirms.
 *
 * **The substitute-admin handover this file used to perform is gone with it.**
 * Deleting an organisation is a superadmin action independent of membership (the specification
 * — „ohne dass … eine Mitgliedschaft nötig wäre"), and `membershipInclude`
 * stops reporting a membership in a deleted Organisation without the
 * row itself being touched. So the old dance — invite a „Nachfolger" admin
 * into each organisation because the last admin cannot remove themselves (the requirement),
 * then have the superadmin leave — bought `deriveActiveTenant` exactly one
 * membership for the next `auth.setup.ts` to scope against, and deleting the
 * Organisation outright buys the same thing at the source, with one fewer surface to
 * drive and no orphaned „Nachfolger" account left in `user` per organisation per run.
 *
 * The installation-wide `system_setting` (Bestätigungstitel, Mailserver,
 * Basis-Adresse) goes back to what it was, exactly as before this run.
 *
 * ## Why it is still its own project, and why that project still depends on the others
 *
 * **This half of „own project" did not change.** It writes the singleton
 * `system_setting` row and it re-scopes the **shared** superadmin session
 * (`PUT /api/session/tenant` writes to the session row, so every context using
 * the parked cookie moves with it). Both are installation-wide, so this file
 * may not run beside anything — that has nothing to do with the trash and
 * everything to do with what Schritt 1–8 themselves do. Playwright has no
 * „exclusive" flag, but it has project dependencies — declaring the other
 * projects as this one's dependencies makes it run strictly last and alone, and
 * that requirement is why the project stays even though the *opt-in* half of
 * its old reason (excluded from `pnpm e2e` to cap the residue, reachable only through a second script)
 * is gone. See `playwright.config.ts`.
 */

test.describe.configure({ mode: 'serial' });

/* --- what the run builds for itself -------------------------------------- */

const STAMP = Date.now().toString(36).toUpperCase().slice(-6);

const TENANT_A = {
  shortName: `D4A${STAMP}`,
  name: `Organisation Aurelia ${STAMP}`,
} as const;
const TENANT_B = {
  shortName: `D4B${STAMP}`,
  name: `Organisation Baltia ${STAMP}`,
} as const;

/**
 * The seeded Organisation the parked superadmin session is at home in — where the
 * cleanup puts that session back (see `afterAll`).
 */
const HOME_TENANT = 'Dachorganisation';

/**
 * What the shipped default says, spelled here as every other spec of this suite
 * spells it (`core-flow`, `mail-log`, `public-form-password`).
 *
 * **This is a constant of the application, not a row in the database**
 * (ADR-0011). What an untouched section means stands in
 * `SYSTEM_FORM_SETTINGS` in `@formsache/shared` and can no longer be adjusted
 * by any run.
 *
 * For Schritt 2 that is the *stronger* statement: a freshly created
 * organisation is able to work without anybody — not even a superadmin —
 * having set anything beforehand.
 */
const SHIPPED_THANKS = 'Vielen Dank!';

/** Two colours no seed uses, so „it followed" cannot be a coincidence. */
const COLOR_A = '#7a1f3d';
const COLOR_B = '#12556b';

const NAME_QUESTION = 'Name des Teilnehmers';
const MAIL_QUESTION = 'E-Mail des Teilnehmers';

/** Every address this run posts to is unroutable by construction (RFC 2606). */
const OFFICE_A = `buero-a-${STAMP.toLowerCase()}@example.invalid`;
const PARTICIPANT_B = `teilnehmer-b-${STAMP.toLowerCase()}@example.invalid`;
const PARTICIPANT_B2 = `teilnehmer-b2-${STAMP.toLowerCase()}@example.invalid`;

const PERSON = {
  name: `D4 Doppelmitglied ${STAMP}`,
  email: `d4-person-${STAMP.toLowerCase()}@example.invalid`,
  /** Derived, never a literal — the reasoning of `seed-account.ts`. */
  password: `${seedAdmin.password}-d4-person`,
} as const;

/**
 * The person who is **only** in organisation B — Schritt 8 creates them, so
 * that the isolation probe does not hit anybody organisation A may see anyway.
 *
 * At module level and no longer in Schritt 8, because the cleanup has to know
 * them: they are one of the three `user` rows every run used to leave behind.
 */
const EXCLUSIVE = {
  name: 'Nur in Organisation B',
  email: `d4-nur-b-${STAMP.toLowerCase()}@example.invalid`,
} as const;

/**
 * The person Schritt 1 **cannot** create — as long as the installation has no
 * mail server (ADR-0024).
 *
 * No password, because there is none and there is meant to be none: the whole
 * case is that **nothing** comes into being here. The address carries the
 * stamp of the run, so that a hit in the list cannot be one from a foreign
 * run.
 */
const WITHOUT_MAILSERVER = {
  name: 'D4 Ohne Mailserver',
  email: `d4-ohne-mail-${STAMP.toLowerCase()}@example.invalid`,
} as const;

/** The name under which Schritt 3b invites the SSO person. */
const SSO_NAME = 'D4 SSO Mitglied';

const GROUP_A = `D4-Redaktion ${STAMP}`;
const GROUP_B = `D4-Lesen ${STAMP}`;

/**
 * The organisation's own OpenID client — Organisation B only, Organisation A stays password-only.
 *
 * **The provider is real and reachable, and the whole round trip goes over
 * the surface.** It lives in its own workspace package, `@formsache/test-idp`,
 * which both consumers resolve the ordinary way — see the file comment there
 * for why that way and not one of the other seven.
 *
 * ⚠️ **What this evidence still does not prove:**
 * the provider is a loopback `http` server that speaks exactly those parts of
 * the protocol this application uses. It proves **no Keycloak peculiarity** —
 * its discovery document, its scope handling, its claim names — and **no TLS
 * statement**. Connecting to the Keycloak of a real operator remains a
 * separate, named remainder.
 */
const OIDC_CLIENT_ID = `formsache-${STAMP.toLowerCase()}`;
const OIDC_CLIENT_SECRET = `${seedAdmin.password}-d4-oidc-secret`;
const SSO_BUTTON = `Mit Organisation-B-SSO anmelden ${STAMP}`;
const SSO_EMAIL = `d4-sso-${STAMP.toLowerCase()}@example.invalid`;
/**
 * What the provider says this person's `sub` is — a UUID because that is what
 * Keycloak mints, and per run, so no two runs share an account key.
 */
const SSO_SUBJECT = `d4-sso-subject-${STAMP.toLowerCase()}`;
/** The heading of the provider's sign-in form — its own, not ours. */
const IDP_HEADING = 'Anmeldung beim Test-Identitätsanbieter';
/**
 * The return point, **registered with the provider** as with a real one.
 *
 * It is no choice of this run but what the server builds out of the base
 * address: Schritt 1 enters `webBaseUrl` as the base address, and
 * `PublicUrlService.oidcCallbackUrl` appends exactly this path. Registering it
 * here means: the test provider is as strict as Keycloak and redirects back to
 * **no** other address — otherwise the test double would be more lenient than
 * reality and the third reproduction of the requirement (the open redirector)
 * would be unobservable in this run.
 */
const OIDC_REDIRECT_URI = `${webBaseUrl}/api/auth/oidc/callback`;

/** A syntactically valid id that belongs to nothing — the „erfundene ID". */
const INVENTED_ID = '00000000-0000-7000-8000-000000000000';

/*
  `/verwaltung/systemeinstellungen` no longer exists: the system level sets no
  form defaults (ADR-0011). What the installation still decides stands on the
  mail-server tab of the system administration.

  Since finding 16 the two addresses below are two **tabs of one** place:
  `/verwaltung/systemeinstellungen/mailserver` und `/verwaltung/superadmin`
  have become `/admin/system/mail` and `/admin/system`. Die alten gibt es seit
  ADR-0030 nicht mehr — this run drives the new ones anyway, because an
  acceptance run should walk the paths that exist and not the ones that are
  merely still handed out.
*/
const SYSTEM_MAIL_PATH = '/admin/system/mail';
const SUPERADMIN_PATH = '/admin/system';
const TENANT_APPEARANCE_PATH = '/admin/appearance';
const TENANT_FORM_DEFAULTS_PATH = '/admin/form-defaults';
const TENANT_MEMBERS_PATH = '/admin/members';
const TENANT_MAIL_PATH = '/admin/mail';
const TENANT_LEGAL_SETTINGS_PATH = '/admin/legal';

/* --- state the steps hand on to one another ------------------------------- */

interface BuiltForm {
  id: string;
  path: string;
  title: string;
}

let adminContext: BrowserContext;
/** The superadmin, on the session `auth.setup.ts` parked. */
let admin: Page;
let systemCatcher: SmtpCatcher;
let tenantCatcher: SmtpCatcher;
/** Organisation B's identity provider, on a loopback port of this worker process. */
let idp: FakeIdp;

let formA: BuiltForm;
let formB: BuiltForm;
let controlFormA: BuiltForm;

/**
 * The live-tenant baseline, read **before** Schritt 1 creates its two
 * Organisationen. `-1` is not a plausible count and so cannot be mistaken for a
 * measurement — if `afterAll` ever compares against it, Schritt 1 never got
 * far enough to read the real one, which is itself the finding.
 */
let tenantsBefore = -1;

/* --- Minimal browser globals, like every other spec of this suite ---------- */

interface ComputedStyle {
  readonly backgroundImage: string;
  getPropertyValue: (property: string) => string;
}
declare function getComputedStyle(element: unknown): ComputedStyle;

/* --- small helpers -------------------------------------------------------- */

/** `#rrggbb` as `getComputedStyle` reports it. */
function rgbOf(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${String((value >> 16) & 0xff)}, ${String((value >> 8) & 0xff)}, ${String(value & 0xff)})`;
}

/** Reads a property off foreign JSON without asserting a shape onto it. */
function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/** The one save bar of a page or card; waits until the save has **landed**. */
async function save(scope: Locator | Page): Promise<void> {
  await scope.getByRole('button', { name: 'Speichern', exact: true }).click();
  // Not the disabled button: it is `isPending || !dirty` and so is already true
  // while the request is in flight. An acceptance run that went on from there would
  // check the next step against the state before the save.
  await expectSaved(scope);
}

/** The id out of a builder address — `/forms/<id>`. */
function formIdOf(url: string): string {
  const id = new URL(url).pathname.split('/')[2];
  expect(id, `[d4] not a builder address: ${url}`).toBeTruthy();
  return id ?? '';
}

/**
 * Switches the signed-in session to the organisation of that name, through the header.
 *
 * `exact: false` on the row, deliberately: the switcher's button carries the
 * organisation's mark, its name, its short name **and** the group the person holds
 * there, so its accessible name is a sentence rather than the name. Each organisation
 * of this run carries a per-run stamp, so a substring is still unambiguous.
 *
 * The row of the organisation one is already in is `disabled` — switching to where one
 * already stands would spend a round trip on nothing — so the early return is
 * not an optimisation but the difference between „nothing to do" and a click
 * that waits five seconds for a control that will never be enabled.
 */
async function switchTenant(page: Page, tenantName: string): Promise<void> {
  await page.goto('/');
  /*
   * **Waited on the subtitle, not on the heading** — pulled across from
   * `durchlauf-funktionsumfang.spec.ts`, where the same edge was corrected in a review.
   *
   * The `<h1>` of the dashboard stands there regardless of whether the session
   * already names an organisation; only the line beneath it says *which one*
   * („Alle Formulare von X" or „Keine Organisation ausgewählt.", `DashboardView.tsx`).
   * The `count()` right below waits on nothing — with the heading as the only
   * edge it decided on a half-painted head and answered „not anchored here"
   * for every organisation alike, i.e. exactly the silent inversion the comment
   * at this place warned about.
   */
  await expect(
    page
      .getByRole('main')
      .getByText(/^(Alle Formulare von .+|Keine Organisation ausgewählt\.)$/u),
  ).toBeVisible();
  const scoped = page
    .getByRole('main')
    .getByText(`Alle Formulare von ${tenantName}`);
  if ((await scoped.count()) > 0) {
    return;
  }

  const switcher = page.getByRole('button', { name: /Organisations-Auswahl/u });
  await expect(switcher).toBeVisible();
  await switcher.click();
  await page.getByRole('button', { name: tenantName }).click();
  await expect(scoped).toBeVisible();
}

/** Builds and publishes a two-question form under the currently active Organisation. */
async function buildForm(page: Page, base: string): Promise<BuiltForm> {
  const title = await newForm(page, base);
  const id = formIdOf(page.url());
  await addQuestion(page, 'Text', NAME_QUESTION);
  await addQuestion(page, 'E-Mail', MAIL_QUESTION);
  await saveForm(page);
  const path = await publishAndReadPath(page);
  return { id, path, title };
}

/**
 * Fills a published form in a **session-less** context and returns the heading
 * of the confirmation page.
 *
 * A fresh context per call, and that is the assertion rather than the plumbing:
 * the public path must work for somebody who has never signed in.
 */
async function fillPublicly(
  browser: Browser,
  form: BuiltForm,
  answers: { readonly name: string; readonly email: string },
): Promise<string> {
  const guest = await browser.newContext();
  const page = await guest.newPage();
  try {
    await page.goto(form.path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Anmelden' })).toHaveCount(0);

    await page.getByLabel(new RegExp(NAME_QUESTION, 'u')).fill(answers.name);
    await page.getByLabel(new RegExp(MAIL_QUESTION, 'u')).fill(answers.email);
    await page.getByRole('button', { name: 'Absenden' }).click();

    /*
     * The state that says „the submission was accepted" is that the level-1
     * heading is no longer the form's own title.
     *
     * Two weaker formulations were tried and both are wrong, which is why this
     * one is spelled out. „Read the h1 after the click" reads the fill-in page,
     * whose h1 *is* the form title. And „wait until no button says Absenden"
     * looks right and is a race: `FillIn` flips the label to „Wird gesendet…"
     * while the request is in flight, so the count reaches zero for a moment
     * with the participant still on the form. Waiting on the heading is
     * waiting on the thing that actually changes.
     */
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).not.toHaveText(form.title);
    return (await heading.textContent()) ?? '';
  } finally {
    await guest.close();
  }
}

/** Every row of the mail log — counted, never the table. */
function mailRows(page: Page): Locator {
  return page.locator('[data-testid^="mail-log-row-"]');
}

/**
 * Waits until the mail log of one form shows `count` delivered rows.
 *
 * A reload inside `expect.poll`, never a `waitForTimeout`: the mail worker runs
 * on its own schedule (`MAIL_WORKER_INTERVAL_MS`), so what is being waited for
 * is a **state** — the row turning „Zugestellt" — and the poll ends the moment
 * it does (`CONTRIBUTING.md`).
 */
async function expectDelivered(
  page: Page,
  formId: string,
  count: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto(`/mail-log/${formId}`);
        await expect(
          page.getByRole('heading', {
            level: 1,
            name: 'E-Mail-Versandprotokoll',
          }),
        ).toBeVisible();
        return mailRows(page).filter({ hasText: 'Zugestellt' }).count();
      },
      {
        message:
          `The Versandprotokoll of form ${formId} must show ${String(count)} ` +
          'delivered row(s). A row stuck on „In Warteschlange" means the mail ' +
          'worker never picked it up or the SMTP block does not reach the ' +
          'catcher this run started.',
        timeout: 120_000,
        intervals: [1000, 2000, 3000, 5000],
      },
    )
    .toBe(count);
}

/** The notification editor of the currently open form. */
function notificationEditor(page: Page): Locator {
  return page.getByRole('region', { name: 'Benachrichtigung' });
}

async function addNotification(
  page: Page,
  fields: {
    readonly name: string;
    readonly subject: string;
    readonly body: string;
    readonly addresses?: string;
    readonly questionId?: string;
  },
): Promise<void> {
  await page.getByRole('button', { name: '+ Neue Benachrichtigung' }).click();
  const editor = notificationEditor(page);
  await editor
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill(fields.name);
  await editor
    .getByRole('textbox', { name: 'Betreff', exact: true })
    .fill(fields.subject);
  await editor
    .getByRole('textbox', { name: 'Text', exact: true })
    .fill(fields.body);

  if (fields.addresses !== undefined) {
    await editor
      .getByRole('textbox', { name: /Weitere Adressen/u })
      .fill(fields.addresses);
  }
  if (fields.questionId !== undefined) {
    await page.getByTestId(`recipient-question-${fields.questionId}`).click();
  }

  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(editor.getByText('Gespeichert', { exact: true })).toBeVisible();
}

/**
 * The id of an organisation the signed-in session is a member of, read from the server.
 *
 * Read rather than remembered: „+ Neue Organisation" does not put the new id
 * anywhere the browser can see it, and writing one down from a network trace
 * would be the kind of fixture that keeps passing after the row it names is
 * gone.
 */
async function tenantIdOf(page: Page, tenantName: string): Promise<string> {
  const body: unknown = await (await page.request.get('/api/auth/me')).json();
  for (const membership of asArray(property(body, 'memberships'))) {
    const tenant = property(membership, 'tenant');
    if (property(tenant, 'name') === tenantName) {
      return String(property(tenant, 'id'));
    }
  }
  throw new Error(`[d4] no membership in „${tenantName}"`);
}

/**
 * The number of **live** organisations the installation reports (this file's baseline and
 * its check).
 *
 * `totals.tenants` off the organisation overview of the system administration — the same query, `AdminService.
 * overview`, that is filtered on (`deletedAt: null`) — rather than
 * counting the length of `tenants` by hand: the totals are what a person reads
 * on that page, and a second, independent count of the same array would only
 * prove the two agree with each other, not with the filter.
 */
async function tenantCount(page: Page): Promise<number> {
  const body: unknown = await (
    await page.request.get('/api/admin/tenants')
  ).json();
  return Number(property(property(body, 'totals'), 'tenants'));
}

/**
 * Fill in and submit the provider's sign-in form — the click a person makes at
 * the IdP.
 *
 * Reached by label and role, as everywhere in this suite: the provider is a
 * foreign interface, and a CSS selector onto it would be an assurance about
 * its markup instead of about the sign-in procedure.
 */
async function signInAtProvider(
  page: Page,
  subject: string,
  email: string,
): Promise<void> {
  await page.getByLabel('Kennung (sub)').fill(subject);
  await page.getByLabel('E-Mail-Adresse').fill(email);
  await page.getByRole('button', { name: 'Anmelden' }).click();
}

/**
 * A `state` that is no longer the issued one — one character different,
 * otherwise the same length and the same shape.
 *
 * Deterministic and without randomness: which letter is swapped must not vary
 * between two runs, otherwise what a red run means varies too. The value is
 * base64url, so a swap within the same alphabet is the manipulation that
 * affects **only** the comparison and not the parsing already.
 */
function tamperState(state: string): string {
  expect(
    state.length,
    'Die Startroute hat gar kein `state` mitgegeben — dann misst dieser Fall ' +
      'nicht die Prüfung, sondern deren Abwesenheit.',
  ).toBeGreaterThan(0);
  const first = state.startsWith('A') ? 'B' : 'A';
  return `${first}${state.slice(1)}`;
}

/** The status of a bare API call under the page's own session. */
async function statusOf(page: Page, path: string): Promise<number> {
  const response = await page.request.get(path);
  return response.status();
}

/** Status **and** body of an API call — „dasselbe 404" needs both. */
async function answerOf(
  page: Page,
  path: string,
): Promise<{ readonly status: number; readonly body: string }> {
  const response = await page.request.get(path);
  return { status: response.status(), body: await response.text() };
}

/* --- setup ---------------------------------------------------------------- */

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext({ storageState: authStateFile });
  admin = await adminContext.newPage();
  systemCatcher = await startSmtpCatcher('d4-system');
  tenantCatcher = await startSmtpCatcher('d4-Organisation-b');
  /*
   * Started here rather than inside Schritt 3b, next to the two mail catchers
   * and for their reason: it is the outside world this run needs, it takes a
   * loopback port, and it has to be closed again whatever a case does. The
   * **API** reaches it over that port too — discovery and the token exchange
   * are calls the server makes, not the browser — which works because both
   * processes sit on the same host in an E2E run.
   */
  idp = await startFakeIdp(OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, {
    redirectUri: OIDC_REDIRECT_URI,
  });
});

/**
 * Puts the installation-wide `system_setting` row back.
 *
 * Called from `afterAll` (below), so this is best-effort by construction: one
 * broken restore must not stop the tenant deletions that follow it, which is
 * why the caller wraps this in its own `try`/`catch` rather than this function
 * swallowing anything itself.
 *
 * **Only the mail server left.** The system level no longer carries form
 * defaults of its own (ADR-0011); there is therefore nothing left on this row
 * to reset that a form would ever get to see.
 *
 * ⚠️ **Since ADR-0024 „back" no longer means „off".** Until then this step
 * switched the mail server off, because that was the seeded state. It is not
 * any more: `auth.setup.ts` enters the run's catcher server, without which
 * **no account** comes into being any more — and `durchlauf-funktionsumfang`
 * runs after this file and invites an SSO person in Schritt 9. An „off" here
 * would therefore be no cleanup but a 422 for the next run.
 *
 * What is restored is therefore the state `auth.setup.ts` set: the same port,
 * the same sender address. The base address already stands at `webBaseUrl`
 * anyway — Schritt 1 entered it that way.
 */
async function restoreSystemSettings(): Promise<void> {
  /*
   * **The same function `auth.setup.ts` uses**, and not a second transcription
   * of host, port, sender address and TLS switch. The four values once stood
   * here a second time — two versions of the same state, i.e. the place where
   * the port drifts apart next time. It drives the page itself and checks the
   * result over a round trip.
   */
  await configureInstanceMailServer(admin, {
    port: instanceMailPort(),
    from: INSTANCE_MAIL_FROM,
  });

  /*
   * The base address does **not** belong to the mail server (it stands in a
   * card of its own on the same tab) and is therefore set here, after the
   * round trip above. It already stands at `webBaseUrl` anyway — Schritt 1
   * entered it that way; this here is the safeguard for a run that broke off
   * in the middle of Schritt 1.
   *
   * **And that is why it reads first and writes afterwards.** `fill()` with
   * the value that already stands there changes nothing — the form stays
   * clean, and `Speichern` is `isPending || !dirty` — so it is locked.
   * `save()` then waits on a button that is never released.
   *
   * *Measured on 2026-08-18:* exactly that consumed the full 300 s of this
   * hook („element is not enabled", 582 repetitions), and because it is the
   * **first** phase, every following one found only a closed page — the whole
   * cleanup part fell away, including the measurement for specification
   * no. 69. The error therefore stood under „Schritt 8", which was itself
   * green.
   */
  const baseAddress = admin
    .getByRole('region', { name: 'Basis-Adresse' })
    .getByRole('textbox', { name: 'Basis-Adresse' });
  if ((await baseAddress.inputValue()) !== webBaseUrl) {
    await baseAddress.fill(webBaseUrl);
    await save(admin);
  }
}

/**
 * Takes a person out of an organisation through *Person entfernen* — and with
 * it, if it was their **last** membership, their account (* `apps/api/src/tenancy/homeless-account.ts`).
 *
 * The residue this run treated as unavoidable up to here was exactly three
 * `user` rows per pass — measured, not assumed: `d4-person`, `d4-sso` and
 * `d4-nur-b` stood in the database after every green run. A deleted
 * organisation does not take them along (it is soft-deleted, and the accounts
 * span organisations), a click on *Person entfernen* does.
 *
 * Idempotent, because every phase of the cleanup has to work even after a
 * break-off in the middle of the run: „nobody stands there any more" is a
 * permissible result — but it is **measured**, not guessed. The waiting edge
 * is the loaded list („Person hinzufügen" is painted only by the loaded branch
 * of `TenantMembersTab.tsx`), and only afterwards does a `count()` decide.
 *
 * @returns whether somebody really was removed.
 */
async function removePerson(
  tenantName: string,
  person: { readonly name: string; readonly email: string },
): Promise<boolean> {
  await switchTenant(admin, tenantName);
  await admin.goto(TENANT_MEMBERS_PATH);
  await expect(
    admin.getByRole('region', { name: 'Person hinzufügen' }),
  ).toBeVisible();

  const row = admin.getByRole('listitem').filter({ hasText: person.email });
  if ((await row.count()) === 0) {
    return false;
  }
  await row.getByRole('button', { name: `${person.name} entfernen` }).click();
  /*
   * `exact: true`: the accessible name of the „×" reads „<Person> entfernen"
   * and thereby contains „Entfernen" — without `exact` the query would match
   * both buttons and click neither.
   */
  await row.getByRole('button', { name: 'Entfernen', exact: true }).click();
  await expect(row).toHaveCount(0);
  return true;
}

/**
 * Can this person still sign in? — the measurement that tells „only the
 * membership is gone" apart from „the account is gone".
 *
 * In a context of its **own**, so that the suite's parked session stays
 * untouched. The status code is the statement: 200 means the account still
 * carries its password; 401 means it is physically gone
 * (`deleteHomelessAccount` deletes the `user` row along with the password hash
 * — a 401 afterwards is the same thing an address that was never created
 * gets).
 */
async function loginStatusOf(
  browser: Browser,
  credentials: { readonly email: string; readonly password: string },
): Promise<number> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expectLoginView(page);
    return await submitLogin(page, credentials);
  } finally {
    await context.close();
  }
}

/**
 * What an organisation of this run **still carries** at the end — per table
 * the run actually touches, read over the application's own routes.
 *
 * The earlier closing assurance counted the **live organisations** only and
 * claimed freedom from residue over the one table that was clean anyway: it
 * did not see the three accounts every run left behind, and it would not see a
 * form whose deletion had failed to happen either. This measurement goes over
 * the tables that are at issue — and it has to run **before** the deletion of
 * the organisation, because afterwards none of these routes answers any more.
 *
 * `forms`, `mails` and `responses` are explicitly **not** a zero value here:
 * this run does not clear its forms away one by one but puts the whole
 * organisation into the trash — the named remainder that goes with the
 * 30-day period. What has to stand at **0** are the memberships apart from
 * that of the superadmin who created the organisation.
 */
interface TenantResidue {
  readonly tenantName: string;
  readonly members: number;
  readonly ownPeople: number;
}

async function measureResidue(tenantName: string): Promise<TenantResidue> {
  await switchTenant(admin, tenantName);
  const answer = await admin.request.get('/api/tenant/users');
  expect(answer.status(), `[d4] /api/tenant/users in „${tenantName}"`).toBe(
    200,
  );
  const members = asArray(property(await answer.json(), 'members'));
  const own = new Set([PERSON.email, SSO_EMAIL, EXCLUSIVE.email]);
  return {
    tenantName,
    members: members.length,
    ownPeople: members.filter((member) =>
      own.has(String(property(member, 'email'))),
    ).length,
  };
}

/**
 * Deletes one organisation through the organisation overview of the system administration — the
 * same „Löschen" control `superadmin-deleted-tenants.spec.ts` drives against a
 * mocked row, driven here for real against the two Organisationen this file created.
 *
 * No membership needed and none is switched into first (the specification: „ohne
 * dass … eine Mitgliedschaft nötig wäre") — the substitute-admin handover this
 * function replaces had to enter each organisation only to satisfy the requirement (the
 * last admin cannot remove themselves), a rule about *leaving* an organisation that
 * deleting one was never subject to.
 *
 * Skips without touching the network if the row is not there: a run that
 * failed **before** Schritt 1 finished creating both Organisationen must not turn this
 * cleanup step into a locator timeout on a row that never existed.
 */
async function deleteTenant(tenant: { readonly name: string }): Promise<void> {
  await admin.goto(SUPERADMIN_PATH);
  // The `<h1>` reads „Systemverwaltung" on all four tabs; the `<h2>` says
  // which one is open.
  await expect(
    admin.getByRole('heading', {
      name: 'Organisationen dieser Installation',
      level: 2,
    }),
  ).toBeVisible();

  /*
   * The waiting edge before the `count()` below, and it needs a **foreign**
   * row — pulled across from `durchlauf-funktionsumfang.spec.ts`: this handle
   * runs even when Schritt 1 never created its organisation, so „not there" is
   * a permissible result here and must not be confused with „not painted yet".
   * The heading alone is not enough for that; the home organisation stands in
   * every installation that runs this suite at all.
   */
  await expect(
    admin.getByRole('row').filter({ hasText: HOME_TENANT }),
  ).toHaveCount(1);

  const row = admin
    .getByRole('row')
    .filter({ hasText: tenant.name })
    .filter({
      has: admin.getByRole('button', { name: 'Löschen', exact: true }),
    });
  if ((await row.count()) === 0) {
    return;
  }

  await row.getByRole('button', { name: 'Löschen', exact: true }).click();
  await admin
    .getByLabel('Name der Organisation zur Bestätigung')
    .fill(tenant.name);
  await admin.getByRole('button', { name: 'Organisation löschen' }).click();
  await expect(row).toHaveCount(0);
}

/**
 * **Cleanup — the run cleans up after itself, including when it broke.**
 *
 * `afterAll`, not a `test()` at the end of the `mode: 'serial'` file: a case
 * placed last never runs once an earlier one fails (Playwright skips the rest
 * of a failed serial group), and that would leave exactly the run that most
 * needs its cleanup without one. `afterAll` runs regardless of how many of
 * Schritt 1–8 passed.
 *
 * Each phase gets its own `try`/`catch`, logged rather than swallowed into
 * silence: a broken system-settings restore must not stop the two tenant
 * deletions after it, and a failed deletion of one organisation must not stop the
 * attempt on the other — two organisations and one broken cleanup step is still better
 * than three. The closing `finally` is what actually matters for every later
 * `pnpm e2e` invocation: the contexts, the two SMTP catchers and the fake IdP
 * close whatever happened above, or the next run inherits a bound port — and
 * each of those four closes carries its own `try` too, for the same reason the
 * phases above do: a `beforeAll` that broke while starting the second SMTP
 * catcher leaves that handle unassigned, and one throwing `close()` must not
 * keep the fake IdP's port bound.
 */
test.afterAll(async ({ browser }) => {
  /*
   * Not the 30 s default. This hook drives roughly eight navigations, two
   * saves and two delete confirmations through the real application — every
   * *case* of this file asks for 180–420 s, and the cleanup is a walk of the
   * same kind. Locally 30 s happened to be enough; on a loaded CI runner it
   * would tear the hook out mid-loop, leave Organisation B alive, skip the
   * account-status assertion entirely and race the `finally` against the
   * teardown.
   *
   * More generous since the people phases below: they drive two additional
   * sign-ins and one switch into each of the two organisations.
   */
  test.setTimeout(300_000);

  try {
    await restoreSystemSettings();
  } catch (error) {
    console.error('[d4] cleanup: restoring system settings failed:', error);
  }

  /*
   * --- the three accounts of this run, and the evidence for specification no. 69 --------
   *
   * **Before** the organisation deletions, because *Person entfernen* needs the
   * Nutzerrechte page of a **live** organisation. Filled by the phases,
   * checked afterwards.
   */
  let doubleMemberAliveAfterFirstTenant: number | undefined;
  let doubleMemberAfterLastTenant: number | undefined;
  let residue: readonly TenantResidue[] | undefined;

  const peoplePhases: readonly (readonly [string, () => Promise<void>])[] = [
    [
      'das Doppelmitglied aus Organisation A zu entfernen',
      async () => {
        if (!(await removePerson(TENANT_A.name, PERSON))) {
          return;
        }
        /*
         * **The one half of the rule only this run can show.**
         * PERSON is in *both* organisations (Schritt 3), so this is **not** the
         * last membership: the account has to survive. Measured against what
         * makes an account — it can still sign in.
         */
        doubleMemberAliveAfterFirstTenant = await loginStatusOf(
          browser,
          PERSON,
        );
      },
    ],
    [
      'das Doppelmitglied aus Organisation B zu entfernen',
      async () => {
        if (!(await removePerson(TENANT_B.name, PERSON))) {
          return;
        }
        // …and this **is** the last one. The same password, the same route.
        doubleMemberAfterLastTenant = await loginStatusOf(browser, PERSON);
      },
    ],
    [
      'die SSO-Person und die Nur-in-B-Person zu entfernen',
      async () => {
        await removePerson(TENANT_B.name, { name: SSO_NAME, email: SSO_EMAIL });
        await removePerson(TENANT_B.name, EXCLUSIVE);
      },
    ],
    [
      'den Rückstand beider Organisationen zu messen',
      async () => {
        residue = [
          await measureResidue(TENANT_A.name),
          await measureResidue(TENANT_B.name),
        ];
      },
    ],
  ];

  for (const [what, phase] of peoplePhases) {
    try {
      await phase();
    } catch (error) {
      console.error(`[d4] cleanup: ${what} failed:`, error);
    }
  }

  for (const tenant of [TENANT_A, TENANT_B]) {
    try {
      await deleteTenant(tenant);
    } catch (error) {
      console.error(`[d4] cleanup: deleting „${tenant.name}" failed:`, error);
    }
  }

  /*
   * --- and back into the organisation the parked session is at home in -------------
   *
   * The shared superadmin session is installation-wide state exactly like the
   * `system_setting` singleton above, so it gets put back exactly like it:
   * without this, the run ends with `active_tenant_id` pointing at an organisation that
   * is in the trash. Nothing in this file's order guarantees otherwise —
   * the last Schritt switches to whichever Organisation it needed — and the next thing
   * to use the parked cookie would inherit that scope.
   *
   * Best-effort like the phases above, and after the deletions rather than
   * before: switching first would only be undone by `deleteTenant`, which drives
   * the organisation overview of the system administration.
   */
  try {
    await switchTenant(admin, HOME_TENANT);
  } catch (error) {
    console.error(
      '[d4] cleanup: switching back to the home Organisation failed:',
      error,
    );
  }

  try {
    /*
     * **The people first, then the organisations.** The number of live
     * organisations alone was the wrong measurement: it was green while three
     * `user` rows with names and addresses stayed behind — the one table that
     * was clean anyway, against the three that were at issue.
     *
     * The comparison against **one** object instead of against individual
     * numbers, so that a failure names everything that is left and not only
     * the first thing.
     */
    expect(
      {
        doubleMemberAliveAfterFirstTenant,
        doubleMemberAfterLastTenant,
        residue,
      },
      'the specification Nr. 69: wer seine **letzte** Mitgliedschaft verliert, verliert sein ' +
        'Konto — und nur dann. 200 nach dem Austritt aus Organisation A heißt „das ' +
        'Konto lebt noch, es hat ja noch Organisation B"; 401 nach Organisation B heißt „mit ' +
        'der letzten Mitgliedschaft ist auch die `user`-Zeile weg". Ein 200 an ' +
        'zweiter Stelle wäre der Rückstand, den dieser Lauf als ' +
        'unvermeidbar führte; ein 401 an erster Stelle wäre schlimmer — dann ' +
        'löschte die Anwendung Konten zu früh.',
    ).toEqual({
      doubleMemberAliveAfterFirstTenant: 200,
      doubleMemberAfterLastTenant: 401,
      residue: [
        // Exactly one membership remains per organisation: the superadmin who
        // created it and is about to put it into the trash.
        { tenantName: TENANT_A.name, members: 1, ownPeople: 0 },
        { tenantName: TENANT_B.name, members: 1, ownPeople: 0 },
      ],
    });

    // The proof that the live count is what it was
    // before this run created its two Organisationen. Left as a real assertion, not a
    // log line — an `afterAll` that only logs a mismatch is the „es sieht
    // aufgeräumt aus" trap this suite guards against.
    expect(
      await tenantCount(admin),
      'the two Organisationen this run created must be gone from the live ' +
        'count again — the reason this file may run inside `pnpm e2e` at all.',
    ).toBe(tenantsBefore);
  } finally {
    /*
     * One `try` per handle — the same shape as the phases above, and for the
     * same reason: a `beforeAll` that threw while starting the *second* SMTP
     * catcher leaves `tenantCatcher` unassigned, and one throwing `close()`
     * would otherwise take `idp.close()` with it — the one handle whose port
     * the next run needs back. `Promise.allSettled` over the four calls would
     * **not** do it: building that array evaluates the calls, so the
     * synchronous `TypeError` of the unassigned handle escapes before
     * `allSettled` ever sees a promise. Thunks in a loop do.
     */
    const handles: readonly (readonly [string, () => Promise<void>])[] = [
      ['the superadmin context', () => adminContext.close()],
      ['the system SMTP catcher', () => systemCatcher.close()],
      ['the organisation SMTP catcher', () => tenantCatcher.close()],
      ['the fake IdP', () => idp.close()],
    ];
    for (const [label, close] of handles) {
      try {
        await close();
      } catch (error) {
        console.error(`[d4] cleanup: closing ${label} failed:`, error);
      }
    }
  }
});

/* --- Schritt 1 ------------------------------------------------------------ */

test('Schritt 1 — der Superadmin richtet System-SMTP und Basis-Adresse ein und legt zwei Organisationen an', async () => {
  test.setTimeout(180_000);

  // The baseline — read **before** either Organisation below exists, so
  // `afterAll`'s cleanup has something correct to be measured against.
  tenantsBefore = await tenantCount(admin);

  /*
    --- no more form defaults of the system ----------------------------------

    The system level carries no form defaults (ADR-0011, finding 9) — the tab
    is gone, and so is `GET/PUT /api/admin/system-settings/form-defaults`.

    The title of this step therefore says „System-SMTP und Basis-Adresse"
    instead of „Systemvorgaben": what the superadmin still sets up here really
    belongs to the installation and not to an organisation.
  */

  // --- mail server and base address of the system --------------------------
  await admin.goto(SYSTEM_MAIL_PATH);
  await expect(
    admin.getByRole('heading', { name: 'Mailserver', exact: true }),
  ).toBeVisible();

  const baseUrlField = admin
    .getByRole('region', { name: 'Basis-Adresse' })
    .getByRole('textbox', { name: 'Basis-Adresse' });

  /*
   * The base address is **cleared first and then set by hand**, and that is
   * the point of this half rather than ceremony: `e2e/global-setup.ts` hands
   * the seed a `SEED_PUBLIC_BASE_URL`, so an E2E database always arrives with
   * one — while Schritt 1 asks for the *superadmin* to set it. Clearing it
   * puts the installation into the state a fresh one is actually in, and the
   * value that ends up stored is the one typed into this field.
   */
  await baseUrlField.fill('');
  await save(admin);
  await admin.reload();
  await expect(
    admin
      .getByRole('region', { name: 'Basis-Adresse' })
      .getByRole('textbox', { name: 'Basis-Adresse' }),
  ).toHaveValue('');

  const mailToggle = admin.getByRole('switch', {
    name: 'Mailserver eingerichtet',
    exact: true,
  });
  /*
   * An aborted earlier run can leave a mail server behind — the row is
   * installation-wide and the cleanup case at the end of this file is the only
   * thing that removes it. Putting it back to „nicht eingerichtet" first is
   * what keeps the state below a *measurement* of the fresh-installation path
   * rather than an accident of what the last run got to.
   */
  if (await mailToggle.isChecked()) {
    await mailToggle.click();
    await save(admin);
    await admin.reload();
  }
  expect(
    await admin
      .getByRole('switch', { name: 'Mailserver eingerichtet', exact: true })
      .isChecked(),
    'A fresh installation has no mail server; this run configures the first one.',
  ).toBe(false);

  /*
    --- and right now **no account** comes into being (ADR-0024) -------------

    The promise that is measurable only in this state: without the instance's
    mail server no invitation can go out, so no person is created either. An
    account half brought into being without a password, whose invitation was
    never sent, would stand in the member list without anybody knowing about it
    — and its address would be taken installation-wide.

    This run is the only place where that can be checked: the `system_setting`
    row is installation-wide, and only this project runs alone
    (`playwright.config.ts`). Every other file would run against a mail server
    that `auth.setup.ts` enters for the whole run.

    Both are measured — the refusal **and** that really nothing came into
    being. A refusal above a created row would be the worse case.
  */
  // Explicitly into the home organisation, instead of relying on where the
  // shared session currently stands: the superadmin is a member of **two**
  // seeded organisations, and an indeterminate selection showed „Kein Tenant
  // ausgewählt" instead of the member list.
  await switchTenant(admin, HOME_TENANT);
  await admin.goto(TENANT_MEMBERS_PATH);
  const refusedInvite = admin.getByRole('region', {
    name: 'Person hinzufügen',
  });
  await expect(refusedInvite).toBeVisible();
  await refusedInvite.getByRole('button', { name: 'Lokaler Nutzer' }).click();
  await refusedInvite
    .getByLabel('Name', { exact: true })
    .fill(WITHOUT_MAILSERVER.name);
  await refusedInvite
    .getByLabel('E-Mail-Adresse', { exact: true })
    .fill(WITHOUT_MAILSERVER.email);
  await refusedInvite.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(
    admin.getByText(
      'Der Mailserver der Instanz ist nicht eingerichtet, und ohne ihn lässt ' +
        'sich keine Einladung verschicken.',
      { exact: false },
    ),
    'Die Absage nennt die Ursache und die Stelle, an der sie zu beheben ist — ' +
      'ein allgemeines „hat nicht geklappt" schickte die Verwaltung einer ' +
      'Organisation auf die Suche nach einem Fehler, der ihr gar nicht gehört.',
  ).toBeVisible();
  await admin.reload();
  await expect(
    admin.getByRole('region', { name: 'Person hinzufügen' }),
  ).toBeVisible();
  await expect(
    admin.getByRole('listitem').filter({ hasText: WITHOUT_MAILSERVER.email }),
    'Es darf **nichts** entstanden sein — auch keine Zeile ohne Passwort.',
  ).toHaveCount(0);

  await admin.goto(SYSTEM_MAIL_PATH);
  await expect(
    admin.getByRole('heading', { name: 'Mailserver', exact: true }),
  ).toBeVisible();
  const mailToggleAgain = admin.getByRole('switch', {
    name: 'Mailserver eingerichtet',
    exact: true,
  });
  await expect(mailToggleAgain).not.toBeChecked();
  // The middle of the switch, never `setChecked` — the dead zone.
  await mailToggle.click();
  await expect(mailToggle).toBeChecked();

  await admin.getByLabel('Host').fill('127.0.0.1');
  await admin.getByLabel('Port').fill(String(systemCatcher.port));
  await admin
    .getByLabel('Absenderadresse')
    .fill('system@formulare.example.invalid');
  /*
   * „Implizites TLS" is **on** in a fresh block (`system-mail-draft.ts`,
   * `secure: smtp?.secure ?? true`), which is the right default for a mail
   * server on the internet and the wrong one for a receiver on loopback. It is
   * switched off here through its own control, exactly as an operator running
   * a local relay would — not by pretending the toggle does not exist.
   */
  const systemTls = admin.getByRole('switch', {
    name: 'Implizites TLS (smtps)',
    exact: true,
  });
  await expect(systemTls).toBeChecked();
  await systemTls.click();
  await expect(systemTls).not.toBeChecked();
  await admin
    .getByRole('region', { name: 'Basis-Adresse' })
    .getByRole('textbox', { name: 'Basis-Adresse' })
    .fill(webBaseUrl);
  await save(admin);

  // Round-trip through the real API, not the draft that was typed.
  await admin.reload();
  await expect(admin.getByLabel('Host')).toHaveValue('127.0.0.1');
  await expect(admin.getByLabel('Port')).toHaveValue(
    String(systemCatcher.port),
  );
  await expect(
    admin
      .getByRole('region', { name: 'Basis-Adresse' })
      .getByRole('textbox', { name: 'Basis-Adresse' }),
  ).toHaveValue(webBaseUrl);

  // --- two organisations, with the superadmin as the first admin (path c) --
  await admin.goto(SUPERADMIN_PATH);
  await expect(
    admin.getByRole('heading', {
      name: 'Organisationen dieser Installation',
      level: 2,
    }),
  ).toBeVisible();

  for (const tenant of [TENANT_A, TENANT_B]) {
    await admin.getByRole('button', { name: '+ Neue Organisation' }).click();
    const form = admin.getByRole('form', { name: 'Neue Organisation' });
    await form.getByLabel('Kurzname').fill(tenant.shortName);
    await form.getByLabel('Name', { exact: true }).fill(tenant.name);
    await form.getByLabel('E-Mail des ersten Admins').fill(seedAdmin.email);
    await form
      .getByLabel('Name des ersten Admins')
      .fill('the acceptance run Superadmin');
    /*
     * **No password field any more** (ADR-0024) — and no invitation goes out
     * here either: the address belongs to the seeded superadmin, so
     * `AdminRepository.createTenant` links the existing account instead of
     * creating one. It knows its password; an invitation would be a second
     * authority over a foreign account.
     */
    await form.getByRole('button', { name: 'Organisation anlegen' }).click();

    const row = admin.getByRole('row').filter({ hasText: tenant.name });
    await expect(row).toHaveCount(1);

    /*
     * **A finding from this run, and it sits exactly on one specific path.**
     *
     * `useCreateTenant` (`apps/web/src/api/admin.ts`) invalidates only
     * `TENANT_OVERVIEW_QUERY_KEY`. The membership the server just created for
     * the address typed above lives in the *session* query, and nothing
     * invalidates that — so the freshly created row is drawn with „Kein
     * Mitglied in dieser Organisation" and offers neither „Wechseln" nor „Verwalten",
     * and the organisation-Wechsler in the header does not list the new Organisation either.
     * The one path the specification decided on so that a superadmin can reach a new
     * Organisation at all therefore *looks* closed at the moment it is opened, and only
     * a reload says otherwise.
     *
     * The reload below is what a person would do next; it is not a workaround
     * for a flake. The assertion is deliberately made **after** it, so this
     * case keeps measuring the capability (a membership exists and the row
     * offers the way in) whether or not the invalidation is added later.
     */
    await admin.reload();
    await expect(row.getByRole('button', { name: 'Verwalten' })).toBeVisible();
    await expect(
      row.getByText('Kein Mitglied in dieser Organisation'),
    ).toHaveCount(0);
  }
});

/* --- Schritt 2 ------------------------------------------------------------ */

test('Schritt 2 — beide Organisationen sind ohne Einrichtung arbeitsfähig: ein neues Formular gilt mit den Systemwerten', async ({
  browser,
}) => {
  test.setTimeout(240_000);

  for (const [tenant, slot] of [
    [TENANT_A, 'A'],
    [TENANT_B, 'B'],
  ] as const) {
    await switchTenant(admin, tenant.name);

    /*
      Nothing is set up in this organisation — the fields carry the
      application's default values.

      **Four sections, not five, and no switching any more** (ADR-0011,
      continuation 2026-08-14; review finding 10). *Verfügbarkeit* stands only
      at the form: a deadline that an organisation prescribed for all of its
      forms would close registrations nobody has looked at. And what an
      untouched section means is not a row somebody could open up but the
      application's default — since 2026-08-17 that simply stands in the
      fields, instead of waiting behind a switch.
    */
    await admin.goto(TENANT_FORM_DEFAULTS_PATH);
    await expect(
      admin.getByRole('heading', { name: 'Formular-Standards' }),
    ).toBeVisible();

    // The counting is the load-bearing half: a fifth card — a resurrected
    // *Verfügbarkeit*, say — would pass through the loop below without a
    // word.
    await expect(admin.getByRole('region')).toHaveCount(4);

    for (const heading of [
      'Zugriff & Sicherheit',
      'Nach dem Absenden',
      'Darstellung',
      'Versandbudget',
    ]) {
      await expect(
        admin.getByRole('region', { name: heading }).locator('fieldset'),
        `Eine frische Organisation darf „${heading}" nicht gesperrt zeigen.`,
      ).toBeEnabled();
    }
    // And no switching, in none of the four cards (review finding 10).
    await expect(admin.getByRole('radiogroup')).toHaveCount(0);

    await expect(
      admin.getByRole('region', { name: 'Verfügbarkeit' }),
      'Eine Organisation darf keine Verfügbarkeit vorgeben — es gibt in der ' +
        'Oberfläche keinen Weg dorthin.',
    ).toHaveCount(0);

    const built = await buildForm(admin, `${slot} Anmeldung`);
    if (slot === 'A') {
      formA = built;
    } else {
      formB = built;
    }

    // The load-bearing half: a stranger fills the form of an organisation nobody
    // configured, and the page they land on carries the **shipped** title.
    const heading = await fillPublicly(browser, built, {
      name: 'Anton Anfang',
      email: slot === 'A' ? 'anton@example.invalid' : PARTICIPANT_B,
    });
    expect(
      heading,
      'A form of a freshly created Organisation must be governed by the shipped ' +
        'defaults, without anybody setting the organisation up — and, since ' +
        'the system layer is gone, without a superadmin having set anything ' +
        'either (ADR-0011, Fortschreibung 2026-08-14).',
    ).toBe(SHIPPED_THANKS);
  }
});

/* --- Schritt 2b ----------------------------------------------------------- */

/**
 * **An organisation's legal texts, from the open item to the filled page**
 * (ADR-0028).
 *
 * ## The gap this step closes
 *
 * Up to 2026-08-19 **no** Playwright case proved the *filled* state: not the
 * filled-in legal text page, not the disappearance of the warning notice on
 * it, not that of the open item on the dashboard and not that of the notice
 * before publishing. What there was was the empty state three times over —
 * `public-form-settings.spec.ts` (the page says that nothing is stored),
 * `tenant-admin.spec.ts` (the tab, without saving) and `app-flows.ts`
 * (`confirmPublishNotice` clicks the notice away).
 *
 * ## Why this stands here of all places
 *
 * Because `tenant.legal_pages` is a **shared** row. Filling it for the
 * Dachorganisation or for Musterstadt would take away the subject of three
 * other cases at once: the dashboard count in `mobile-targets.spec.ts`
 * („zehn Bedienelemente", one of them „Zu den Rechtstexten"), the confirmation
 * dialogue in `builder-drag.spec.ts` and the empty page in
 * `public-form-settings.spec.ts`. The clean way is an organisation that exists
 * only for this purpose — and this run creates two of them, has a session for
 * them and deletes them again at the end.
 *
 * It is at the same time the only file of the suite in which the **isolation**
 * of this column can be measured: organisation A fills its texts, and
 * organisation B says unchanged afterwards that nothing is stored. A column
 * that was accidentally read installation-wide would show up exactly here.
 *
 * ## The arc this step drives
 *
 * `empty` → `incomplete` → `ready`, and at every station what the application
 * shows for it. The middle station is no ornament: the warning notice on the
 * page belongs **solely** to the state `incomplete` — an empty page does not
 * show it but its substitute text. A case that jumped straight from empty to
 * finished would never have seen it.
 *
 * ⚠️ **The middle station is two stations, because the fold has its own
 * middle** (2026-08-20). `tenantLegalStatus` takes the *worse* of the two
 * pages, so (4) — one entry in the provider details, the privacy notice
 * untouched — is `incomplete` for the **page** and still `empty` for the
 * **pair**. The notice before publishing reads the pair, so at (4) it still
 * says „Für diese Organisation fehlen Rechtstexte." (4b) is therefore its own
 * station: it starts the second page as well, and only then does the hint
 * reach its third wording. Without it the state `incomplete` of
 * `organisationLegal` is driven by no Playwright case at all — every other
 * place that meets this dialog meets the empty organisation
 * (`confirmPublishNotice` on every republish of the suite,
 * `publish-legal-hint.spec.ts` twice against Musterstadt's untouched row), and
 * those must stay empty.
 *
 * ## Reproduction
 *
 * Every single station breaks on its own:
 *
 * - in `views/tenant-setup/open-items.ts` change the `!== 'ready'` to
 *   `=== 'empty'` — the open item then stays away at `incomplete` and stays
 *   standing at `ready`;
 * - in `BuilderView.needsPublishNotice` delete the `legalIncomplete` — then
 *   the dialogue is already missing in (3);
 * - let `tenantLegalStatus` (`@formsache/shared`, `legal.ts`) return the
 *   **better** of the two states instead of the worse — (4b) then reads
 *   „fehlen Rechtstexte" where „sind unvollständig" is owed, and nothing else
 *   of this file moves;
 * - in `LegalPageView` change the condition `page.status === 'incomplete'` to
 *   `!== 'empty'` — the warning notice would then stay standing on the
 *   finished page;
 * - in `PublicLegalService.tenantPage` switch the `where` condition from the
 *   short name to „any organisation" — then B suddenly carries A's text.
 */
test('Schritt 2b — Organisation A füllt ihre Rechtstexte aus: der offene Punkt, der Warnhinweis und der Hinweis vor dem Veröffentlichen verschwinden, und Organisation B bleibt leer', async ({
  browser,
}) => {
  test.setTimeout(300_000);

  /** The one value by which the filled page can be recognised. */
  const ORT = `Aurelia am Strom ${STAMP}`;
  /** What goes into every remaining field — content is not the subject here. */
  const FILLER = `Angabe ${STAMP}`;

  const imprintPath = `/o/${TENANT_A.shortName}/imprint`;
  const privacyPath = `/o/${TENANT_A.shortName}/privacy`;

  await switchTenant(admin, TENANT_A.name);

  /* --- (1) the dashboard carries the item --------------------------------- */

  const openItems = admin.getByRole('region', {
    name: 'Offene Punkte dieser Organisation',
  });
  await expect(
    openItems,
    'Eine Organisation mit Formularen und ohne Rechtstexte muss den Kasten ' +
      'offener Punkte zeigen. Fehlt er ganz, hat entweder Schritt 2 kein ' +
      'Formular hinterlassen (dann steht hier die Einrichtungs-Fassung) oder ' +
      'die Liste leitet sich nicht mehr aus dem Zustand ab.',
  ).toBeVisible();
  await expect(
    openItems.getByText('Keine Rechtstexte dieser Organisation hinterlegt'),
  ).toBeVisible();

  /*
    **The second item is taken along, although it is not the subject.**
    Organisation A gets no mail server of its own in this run (Schritt 5
    measures precisely that), so „Zum Mailversand" stands here from beginning
    to end. It is the control for (6): if the *whole* list disappears at the
    end, it is not the item that is done but the derivation that is broken.
  */
  await expect(
    openItems.getByRole('button', { name: 'Zum Mailversand' }),
  ).toBeVisible();
  await expect(
    openItems.getByRole('button', { name: 'Zu den Rechtstexten' }),
  ).toBeVisible();

  /* --- (2) and the public page says that there is nothing ----------------- */

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();

  /** The card of a legal text page — `<article class="legal__card">`. */
  const legalCard = guest.getByRole('article');

  try {
    await guest.goto(imprintPath);
    await expect(
      guest.getByRole('heading', { level: 1, name: 'Anbieterangaben' }),
    ).toBeVisible();
    await expect(legalCard).toContainText(
      'Für dieses Formular sind bislang keine Anbieterangaben hinterlegt.',
    );

    /* --- (3) and the notice halts the publishing -------------------------- */

    const legalForm = await buildForm(admin, 'A Rechtstexte');

    /*
      **A reworded label**, and both things about it are measured rather than
      guessed:

      - It is a change that *unlocks* the button. A changed **form name** is
        not — the button then stays locked with „Es gibt keine Änderungen
        gegenüber der veröffentlichten Fassung" (seen in the browser on
        2026-08-19, after the title stood here first).
      - And it is one that `publishDiff` does **not** report
        (`builder-drag.spec.ts` records exactly that). Together with „no
        answer, nothing locked" the only reason left for the dialogue is
        therefore the notice about the legal texts — which is what (7)
        counter-checks at the end.

      `buildForm` inserted the second question last, so it still stands in the
      properties area; nothing has to be selected here.
    */
    await admin.getByLabel('Fragetext').fill(`${MAIL_QUESTION}, Fassung 2`);
    await saveForm(admin);
    await admin.getByRole('button', { name: 'Erneut veröffentlichen' }).click();
    await confirmPublishNotice(admin);
    await expect(admin.getByText('Fassung 2 veröffentlicht')).toBeVisible();

    /* --- (4) a single entry: incomplete, and the page says so -------------- */

    /*
      Ein Eintrag, und er landet in **zwei** Seiten: „Ort" ist ein geteiltes
      Feld dieser Ebene und läuft mit (Review-Runde 3 Nr. 3). Hier zählt nur
      die Karte, in die getippt wurde; die andere Seite nimmt (4b) auf.
    */

    await admin.goto(TENANT_LEGAL_SETTINGS_PATH);
    const imprintCard = admin.getByRole('region', { name: 'Anbieterangaben' });
    await expect(imprintCard).toBeVisible();
    await expect(imprintCard.getByText('Nichts hinterlegt')).toBeVisible();

    await imprintCard
      .getByRole('textbox', { name: 'Ort', exact: true })
      .fill(ORT);
    await expect(
      imprintCard.getByText('Unvollständig', { exact: true }),
    ).toBeVisible();
    await save(admin);

    await guest.goto(imprintPath);
    /*
      **Review-Runde 5 Nr. 1.** Hier stand die Gegenprobe: die Seite *musste*
      den Hinweis „Diese Angaben sind unvollständig. Es fehlt: …" tragen und die
      Lücken benannt zeigen. Der Befund war: *„unvollständige Angaben sollten
      nicht in der öffentlichen Ansicht angezeigt werden. Das sieht nicht gut
      aus."* Gemessen wird deshalb jetzt die andere Richtung — und die wahre
      Angabe weiterhin: eine Seite, die beim ersten fehlenden Feld verstummte,
      wäre die schlechtere Antwort auf denselben Befund.
    */
    await expect(
      legalCard,
      'Der eine Wert, der hinterlegt ist, muss auf der Seite stehen: eine ' +
        'unvollständige Seite zeigt, was wahr ist, statt zu schweigen. ⚠️ Und ' +
        'genau hier hängt er an der Regel: „Ort" steht in der Vorlage auf ' +
        'derselben Zeile wie die fehlende Postleitzahl. Eine Fassung, die jede ' +
        'Zeile mit einer Lücke streicht, nimmt ihn mit — der Review dieser ' +
        'Änderung hat es nachgerechnet.',
    ).toContainText(ORT);
    await expect(
      legalCard,
      'Der Warnhinweis über die offenen Angaben gehört seit Review-Runde 5 ' +
        'Nr. 1 nicht mehr in die öffentliche Ansicht — der Zustand reist gar ' +
        'nicht mehr mit.',
    ).not.toContainText('Diese Angaben sind unvollständig.');
    await expect(
      legalCard,
      'Auch die Marke im Text ist draußen: die Zeile mit der offenen Angabe ' +
        'entfällt mitsamt ihrer Beschriftung.',
    ).not.toContainText('Angabe fehlt');
    await expect(
      legalCard,
      'Ein „[[…]]" verlässt `renderLegalPage` nie — in keiner Zielgruppe.',
    ).not.toContainText(/\[\[[A-Z0-9_]+\]\]/u);

    /* --- (4b) both pages started: the hint reads „unvollständig" ----------- */

    /*
      **The third wording of the hint, and the only place in this suite that
      reaches it.** The docblock above says why it needs a station of its own:
      the fold takes the worse of the two pages, so one entry in the provider
      details leaves the pair at `empty`. Both pages have to be started for the
      pair to be `incomplete`.

      ⚠️ **Und genau das ist seit Review-Runde 3 Nr. 3 schon geschehen.** „Ort"
      steht in *beiden* Vorlagen dieser Ebene, und ein geteiltes Feld wird beim
      Tippen mitgeführt (`applySharedFills`) — der eine Eintrag in (4) hat die
      Datenschutzhinweise also mit angefangen und mit gespeichert. Dieser
      Abschnitt füllt deshalb nichts mehr nach, sondern **misst** es: die
      zweite Karte trägt den Wert und den Zustand, ohne dass ihn jemand dort
      eingetippt hätte. Stünde hier wieder „Nichts hinterlegt", liefe das
      Mitführen nicht bis in die gespeicherte Fassung durch — und der Befund
      wäre zurück, ohne dass ein Einheitstest es merkte.
    */
    await admin.goto(TENANT_LEGAL_SETTINGS_PATH);
    const privacyCard = admin.getByRole('region', {
      name: 'Datenschutzhinweise',
    });
    await expect(
      privacyCard.getByRole('textbox', { name: 'Ort', exact: true }),
      'Der Ort wurde in den Anbieterangaben eingetragen und steht in beiden ' +
        'Vorlagen. Ist er hier leer, wird er nicht mitgeführt — dann tippt ' +
        'man ihn wieder zweimal.',
    ).toHaveValue(ORT);
    await expect(
      privacyCard.getByText('Unvollständig', { exact: true }),
      'Beide Seiten müssen jetzt „Unvollständig" tragen — sonst steht der ' +
        'Zustand nicht her, den der Dialog gleich lesen soll.',
    ).toBeVisible();

    /*
      A reworded label again, for the reason (3) states: it unlocks the button
      and `publishDiff` does not report it, so the notice has no second reason
      to appear. Frage 2 is the one (3) already touched; Frage 1 stays for (7),
      which reworks it into „Fassung 3".
    */
    await admin.goto(`/forms/${legalForm.id}`);
    await expect(admin.getByLabel('Formularname')).toHaveValue(legalForm.title);
    await admin.getByRole('button', { name: 'Frage 2 bearbeiten' }).click();
    await admin.getByLabel('Fragetext').fill(`${MAIL_QUESTION}, angefangen`);
    await saveForm(admin);
    await admin.getByRole('button', { name: 'Erneut veröffentlichen' }).click();

    const startedNotice = admin.getByRole('dialog', {
      name: 'Erneut veröffentlichen?',
    });
    const startedHint = startedNotice.getByRole('region', {
      name: 'Rechtstexte dieser Organisation',
    });
    await expect(startedHint).toBeVisible();
    await expect(
      startedHint.getByRole('heading', {
        name: 'Die Rechtstexte dieser Organisation sind unvollständig.',
      }),
      'Angefangene Rechtstexte sind etwas anderes als fehlende, und der ' +
        'Hinweis hat für beides eigene Worte. Steht hier die Überschrift des ' +
        'leeren Zustands, faltet `tenantLegalStatus` die beiden Seiten nicht ' +
        'zum schlechteren, sondern zum leeren.',
    ).toBeVisible();
    await expect(
      startedHint,
      'Der leere Zustand darf jetzt nicht mehr dastehen: auf beiden Seiten ' +
        'ist etwas hinterlegt.',
    ).not.toContainText('fehlen Rechtstexte');

    /*
      And the second stage along with it: this session manages the settings of
      this organisation, so the hint may name the pages — both of them, since
      neither is finished. `publish-legal-hint.spec.ts` measures the other side
      of that guard (an editor without the right gets no page name), but only
      in the empty state; here the same assurance stands in the started one.
    */
    await expect(startedHint).toContainText('Betroffen');
    for (const title of ['Anbieterangaben', 'Datenschutzhinweise']) {
      await expect(startedHint).toContainText(title);
    }

    /*
      **And it does not lock here either** (ADR-0028 §6). „Abbrechen" closes
      the dialog and the version in force stays the one it was: the hint costs
      a click, it takes no decision away.
    */
    await startedNotice.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(startedNotice).toHaveCount(0);
    await expect(
      admin.getByText('Veröffentlicht (Fassung 2)'),
      'Nach „Abbrechen" darf nichts veröffentlicht worden sein. Steht hier ' +
        'Fassung 3, veröffentlicht der Dialog beim Wegklicken — das Gegenteil ' +
        'dessen, wofür er da ist.',
    ).toBeVisible();

    /* --- (5) fill both pages in completely --------------------------------- */

    await admin.goto(TENANT_LEGAL_SETTINGS_PATH);
    for (const title of ['Anbieterangaben', 'Datenschutzhinweise']) {
      const card = admin.getByRole('region', { name: title });
      await expect(card).toBeVisible();

      /*
        **The recognition value into both cards**, and before the loop below
        runs: „Ort" exists in both templates, but the two documents stand
        separately side by side (`fills` per page). Without this line the
        privacy notice page would only get the filler value, and the assurance
        „the stored value stands on the page" would be none for it — measured
        on 2026-08-19, when it went red on exactly that.
      */
      await card.getByRole('textbox', { name: 'Ort', exact: true }).fill(ORT);

      /*
        **Every remaining field the card offers** — and not a list of
        placeholders typed out here. The list would stand in
        `legal-templates.ts` a second time, and the copy would be the one that
        goes stale with the next set of templates; `visibleSlots` decides which
        fields currently apply anyway.
      */
      const fields = card.getByRole('textbox');
      const count = await fields.count();
      expect(
        count,
        `„${title}" bietet kein einziges Feld an. Dann füllt diese Schleife ` +
          'nichts, und alles danach misst einen Zustand, den niemand ' +
          'hergestellt hat.',
      ).toBeGreaterThan(0);
      for (let index = 0; index < count; index += 1) {
        const field = fields.nth(index);
        if ((await field.inputValue()).trim() === '') {
          await field.fill(FILLER);
        }
      }

      await expect(
        card.getByText('Vollständig', { exact: true }),
        `„${title}" gilt nach dem Ausfüllen aller angebotenen Felder immer ` +
          'noch nicht als fertig. Dann zählt `legalPageStatus` einen ' +
          'Platzhalter, den `visibleSlots` gar nicht anbietet — die beiden ' +
          'stehen genau deshalb nebeneinander.',
      ).toBeVisible();
    }
    await save(admin);

    /* --- the page now carries the text, without a warning notice ---------- */

    for (const [path, heading] of [
      [imprintPath, 'Anbieterangaben'],
      [privacyPath, 'Datenschutzhinweise'],
    ] as const) {
      await guest.goto(path);
      await expect(
        guest.getByRole('heading', { level: 1, name: heading }),
      ).toBeVisible();
      await expect(
        legalCard,
        `${heading}: der Warnhinweis steht immer noch da, obwohl keine Angabe ` +
          'mehr offen ist.',
      ).not.toContainText('Diese Angaben sind unvollständig.');
      await expect(
        legalCard,
        `${heading}: die hinterlegte Angabe steht nicht auf der Seite.`,
      ).toContainText(ORT);
      await expect(
        legalCard,
        `${heading}: der Ersatztext der leeren Seite steht noch da, obwohl ` +
          'etwas hinterlegt ist.',
      ).not.toContainText('bislang keine Anbieterangaben hinterlegt');
      await expect(legalCard).not.toContainText(/\[\[[A-Z0-9_]+\]\]/u);
    }

    /* --- and organisation B is untouched by it ----------------------------- */

    await guest.goto(`/o/${TENANT_B.shortName}/imprint`);
    await expect(
      guest.getByRole('article'),
      'Die Rechtstexte hängen an **einer** Organisation. Trägt B nach dem ' +
        'Speichern in A plötzlich einen Text, wird die Spalte nicht je Zeile ' +
        'gelesen — das wäre dieselbe Verwechslung, die Schritt 8 für die IDs ' +
        'von Hand ausschließt.',
    ).toContainText(
      'Für dieses Formular sind bislang keine Anbieterangaben hinterlegt.',
    );
    /* --- (6) the open item is gone, the other one stands ------------------ */

    await admin.goto('/');
    await expect(
      admin.getByRole('region', { name: 'Offene Punkte dieser Organisation' }),
      'Der Kasten muss stehen bleiben: der Mailserver dieser Organisation fehlt ' +
        'weiterhin. Ist er ganz weg, ist nicht ein Punkt erledigt, sondern die ' +
        'Liste abgeschaltet.',
    ).toBeVisible();
    await expect(
      admin.getByRole('button', { name: 'Zum Mailversand' }),
    ).toBeVisible();
    await expect(
      admin.getByRole('button', { name: 'Zu den Rechtstexten' }),
      'Der Punkt „Zu den Rechtstexten" muss verschwunden sein. Steht er noch ' +
        'da, liest die Liste einen „übersprungen"-Merker statt des Zustands — ' +
        'genau das, was `tenantOpenItems` ausdrücklich nicht tut.',
    ).toHaveCount(0);

    /* --- (7) and publishing no longer asks back ---------------------------- */

    await admin.goto(`/forms/${legalForm.id}`);
    await expect(admin.getByLabel('Formularname')).toHaveValue(legalForm.title);

    /*
      **The question is selected through its type badge** and not through the
      card. The path is the only one there is without a mouse (`QuestionCard`
      gives the reason), and it is needed here because (4)–(6) left the
      builder: after coming back no question is open, and without an open
      question there is no field „Fragetext".
    */
    await admin.getByRole('button', { name: 'Frage 1 bearbeiten' }).click();
    await admin.getByLabel('Fragetext').fill(`${NAME_QUESTION}, Fassung 3`);
    await saveForm(admin);
    await admin.getByRole('button', { name: 'Erneut veröffentlichen' }).click();

    const notice = admin.getByRole('dialog', {
      name: 'Erneut veröffentlichen?',
    });
    const published = admin.getByText('Fassung 3 veröffentlicht');

    /*
      **What is waited on is an outcome, not a clock.**
      `onPublishRequested` first fetches the preview (`step: 'checking'`), so
      there is a moment in which neither the dialogue nor the success message
      stands there. Whoever asks „is the dialogue there?" in that moment
      measures the loading state — exactly the sort of race this suite must not
      have.
    */
    await expect
      .poll(
        async () => {
          if ((await notice.count()) > 0) {
            return 'dialog';
          }
          return (await published.count()) > 0 ? 'veröffentlicht' : 'wartet';
        },
        {
          message:
            'Nach „Erneut veröffentlichen" muss entweder der Rückfrage-Dialog ' +
            'stehen oder die Fassung heraus sein. Bleibt es bei „wartet", ist ' +
            'der Klick nicht angekommen oder die Vorschau antwortet nicht.',
        },
      )
      .not.toBe('wartet');

    /*
      **The assurance is the section, not the dialogue.**
      `publish-legal-hint` belongs to ADR-0028 and is the only part of the
      dialogue this step says anything about: it stood in (3) and has to be
      gone now.

      Explicitly **not** „the dialogue does not come any more at all". It has
      several reasons — locked conditions, answers together with changed
      questions, and since 2026-08-19 a second legal-text notice that *this*
      form triggers (ADR-0028, open point 4: the form-specific privacy notice).
      Tying this case to „no dialogue" would mean hanging it on a rule it says
      nothing about.
    */
    await expect(
      notice.getByTestId('publish-legal-hint'),
      'Der Hinweis auf die **Rechtstexte der Organisation** muss weg sein, ' +
        'sobald beide Seiten vollständig sind. Er kostet einen zusätzlichen ' +
        'Klick je Veröffentlichung, **solange die Texte fehlen** — und keinen ' +
        'mehr, sobald sie stehen (ADR-0028 §6 Nr. 3).',
    ).toHaveCount(0);

    /*
      If the dialogue still stands for one of the other reasons, it is
      confirmed — the poll above established the state beforehand, so nothing
      is guessed here.
    */
    if ((await notice.count()) > 0) {
      await notice
        .getByRole('button', { name: 'Erneut veröffentlichen', exact: true })
        .click();
      await expect(notice).toHaveCount(0);
    }
    await expect(published).toBeVisible();
  } finally {
    await guestContext.close();
  }
});

/* --- Schritt 3 ------------------------------------------------------------ */

test('Schritt 3 — Branding wirkt an der öffentlichen Ausfüllansicht, Gruppen stehen, und eine Person sieht in A mehr als in B', async ({
  browser,
}) => {
  test.setTimeout(300_000);

  // --- branding per organisation ---------------------------------------------------
  for (const [tenant, colour] of [
    [TENANT_A, COLOR_A],
    [TENANT_B, COLOR_B],
  ] as const) {
    await switchTenant(admin, tenant.name);
    await admin.goto(TENANT_APPEARANCE_PATH);
    await expect(
      admin.getByRole('heading', {
        name: 'Organisations-Verwaltung',
        level: 1,
      }),
    ).toBeVisible();

    await admin.getByLabel('Kopfzeilen-Hintergrund').fill(colour);
    await admin.getByLabel('Akzent (Buttons, Fortschritt)').fill(colour);
    /*
      **The stripe is maintained directly** (finding 8): filling in the stripe
      field *is* the maintenance, no button copies values out of a second
      source.
    */
    await admin.getByLabel('Streifenfarbe 1 von 3').fill(colour);
    await save(admin.locator('.tenant-admin__tab > .settings__actions'));
  }

  /*
   * ⚠️ Measured on a **second** Organisation, and on the rendered page.
   *
   * The seed's Dachorganisation carries the default palette, so a colour read there cannot
   * tell „the organisation's branding arrived" from „the `:root` fallback was used" —
   * which is exactly how an earlier run found that organisation branding
   * had never reached the public view at all, through 2500 green unit tests.
   * Both organisations here are new, both carry a colour no seed uses, and the two
   * differ from each other, so a page painted from the wrong Organisation fails too.
   */
  for (const [form, colour, other] of [
    [formA, COLOR_A, COLOR_B],
    [formB, COLOR_B, COLOR_A],
  ] as const) {
    const guest = await browser.newContext();
    const page = await guest.newPage();
    try {
      await page.goto(form.path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      const axis = await page
        .getByRole('main')
        .evaluate((element) =>
          getComputedStyle(element).getPropertyValue('--tenant-accent').trim(),
        );
      expect(
        axis,
        'The session-less fill-in view must be themed from the organisation of the form.',
      ).toBe(colour);

      const submit = await page
        .getByRole('button', { name: 'Absenden' })
        .evaluate((element) => getComputedStyle(element).backgroundImage);
      expect(submit).toContain(rgbOf(colour));
      expect(submit).not.toContain(rgbOf(other));
    } finally {
      await guest.close();
    }
  }

  // --- groups per organisation, and the same person in both ------------------------
  const groupCard = (name: string): Locator =>
    admin
      .locator('.tenant-admin__group-card')
      .filter({ has: admin.getByLabel(`Name der Gruppe ${name}`) });

  /*
    ⚠️ **„Einstellungen der Organisation", no longer „Einstellungen"**
    (ADR-0021). The one right `canManageSettings` has become two:
    *Formular-Einstellungen* for **one** form and *Einstellungen der
    Organisation* for the organisation. Two pills that were both called
    „Einstellungen" would be a rights editor in which one has to guess — that
    is why they are explicitly named differently, and that is why the old
    literal no longer hits any pill here.

    Measured: this step failed at „element(s) not found" for
    `getByRole('button', { name: 'Einstellungen', exact: true })`. The `exact`
    is what saves it — without it the old literal would have hit both new pills
    and clicked one of them.

    This group holds **both**, and that is no convenience: it is the group on
    which this step demonstrates „in A mehr als in B", and what it measures for
    that are the entries of the form navigation further down. Since ADR-0021
    those hang on `canManageFormSettings` (`FormNav.tsx`) — the one right that
    used to be both is split, and granting only half of it would mean putting
    the case on a right the view under test no longer reads at all. Measured:
    with only „Einstellungen der Organisation", „Formular-Einstellungen" was
    missing from the navigation — rightly so.

    The state of the inbox is taken **before** the first „Hinzufügen": what an
    earlier case sent to the same address must not be read as this invitation
    (ADR-0024).
  */
  const inboxBeforeInvite = systemCatcher.messages.length;
  for (const [tenant, groupName, permissions] of [
    [
      TENANT_A,
      GROUP_A,
      [
        'Bearbeiten',
        'Antworten ansehen',
        'Export',
        'Formular-Einstellungen',
        'Einstellungen der Organisation',
      ],
    ],
    [TENANT_B, GROUP_B, ['Antworten ansehen']],
  ] as const) {
    await switchTenant(admin, tenant.name);
    await admin.goto(TENANT_MEMBERS_PATH);
    await expect(
      admin.getByRole('region', { name: 'Person hinzufügen' }),
    ).toBeVisible();

    await admin.getByRole('button', { name: '+ Gruppe hinzufügen' }).click();
    const fresh = groupCard('Neue Gruppe');
    await expect(fresh).toBeVisible();
    await fresh.getByLabel('Name der Gruppe Neue Gruppe').fill(groupName);
    for (const permission of permissions) {
      const pill = fresh.getByRole('button', { name: permission, exact: true });
      await expect(pill).toHaveAttribute('aria-pressed', 'false');
      await pill.click();
      await expect(pill).toHaveAttribute('aria-pressed', 'true');
    }
    await fresh.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(groupCard(groupName)).toBeVisible();

    const invite = admin.getByRole('region', { name: 'Person hinzufügen' });
    await invite.getByLabel('Name', { exact: true }).fill(PERSON.name);
    await invite
      .getByLabel('E-Mail-Adresse', { exact: true })
      .fill(PERSON.email);
    /*
     * **No password field any more** (ADR-0024). The pass through organisation
     * A creates the account and sends the invitation; the one through
     * organisation B finds the same address and only **attaches** —
     * `attachExisting` queues nothing there. That is why the link is fetched
     * once **after** the loop and not twice inside it.
     */
    await expect(
      invite.getByLabel('Passwort', { exact: true }),
      'Ein Passwortfeld im Block „Person hinzufügen" wäre der alte Weg.',
    ).toHaveCount(0);
    await invite
      .getByLabel('Rolle', { exact: true })
      .selectOption({ label: groupName });
    await invite.getByRole('button', { name: 'Hinzufügen' }).click();

    /*
      **Two passes, two messages** — and the difference is the assurance, not a
      subtlety of the wording.

      The comment above the password field has said it since ADR-0024: A
      creates the account and invites, B finds the same address and only
      **attaches**. The message followed suit as of `dba9523` — before that the
      interface claimed for both passes that an invitation had gone out. This
      line went on claiming it and was therefore red from 2026-08-18.

      Pinning it to the invitation wording would mean making the case blind to
      the difference again. What is checked is therefore **the right half per
      pass** — and the second is the one that matters: for an account that
      already exists, **no** second mail goes out over the installation's
      SPF/DKIM-signing server. That the inbox afterwards carries exactly *one*
      invitation is measured by the evaluation under `inboxBeforeInvite`; that
      the interface promises nothing else is measured by this line.

      *Reproduction:* set both branches to the same message → one of the two
      passes goes red.
    */
    await expect(
      admin.getByText(
        tenant === TENANT_A
          ? `✓ ${PERSON.name} wurde hinzugefügt und hat eine Einladung per Mail bekommen.`
          : `✓ ${PERSON.name} wurde hinzugefügt. Das Konto gab es schon — die ` +
              'Anmeldung läuft mit dem vorhandenen Passwort, es geht keine ' +
              'Einladung hinaus.',
      ),
    ).toBeVisible();
  }

  /*
   * --- the invitation, caught and redeemed ---------------------------------
   *
   * The evidence this run additionally provides since ADR-0024: the mail
   * really goes out over SMTP, its link stands in the delivered message (not
   * in the frozen body of the mail log — a marker stands there), and **the
   * person themselves** sets their password with it. Only afterwards can the
   * sign-in below measure anything at all.
   */
  /*
    **The run's own catcher server, not the shared channel of the suite.**

    Schritt 2 pointed the *installation's* mail server at `systemCatcher`
    (`admin.getByLabel('Port').fill(String(systemCatcher.port))`). From that
    line on **every** system mail goes there — including the invitation
    ADR-0024 triggers. `readInstanceMail()`, by contrast, reads the channel
    `auth.setup.ts` entered for the rest of the suite, and that one stays empty
    for this file to the end.

    *Measured on 2026-08-18:* `waitForInvitationLink` stood here without
    `inbox`, waited 120 s and reported „6 messages in total, 0 since index 6".
    The mail had long been out by then — `mail_log` carried it as `sent`,
    `sender_identity: system`, one attempt, no error. It was no fault of the
    application and none of the queue, but a reader at the wrong mailbox.

    It only came to light on that day because this project depends on
    `mobile-360x740` and therefore, as long as the mobile cases were red, **did
    not run at all** („27 did not run").
  */
  const invitationLink = await waitForInvitationLink(PERSON.email, {
    after: inboxBeforeInvite,
    inbox: () => systemCatcher.messages,
  });
  expect(
    invitationLink.startsWith(webBaseUrl),
    'Der Link muss auf die Basis-Adresse der **Installation** zeigen, die ' +
      'Schritt 1 eingetragen hat — nie auf eine, die eine Organisation setzt ' +
      '(ADR-0020 §5).',
  ).toBe(true);
  await redeemInvitation(browser, invitationLink, PERSON.password);

  // --- the person signs in and sees two different organisations ---------------------
  const personContext = await browser.newContext();
  const person = await personContext.newPage();
  try {
    await person.goto('/');
    await expectLoginView(person);
    expect(
      await submitLogin(person, {
        email: PERSON.email,
        password: PERSON.password,
      }),
      'The person added in Organisation A must be able to sign in — a second „Person ' +
        'hinzufügen" with the same address links the existing account rather ' +
        'than creating a rival one.',
    ).toBe(200);

    // Two memberships, so the session arrives **unscoped** — the switcher is
    // the only way in, and that is what makes „in A mehr als in B" visible.
    await expect(
      person.getByRole('banner').getByText('Keine Organisation ausgewählt'),
    ).toBeVisible();

    await switchTenant(person, TENANT_A.name);
    await expect(
      person.getByRole('article').filter({ hasText: formA.title }),
    ).toHaveCount(1);
    expect(
      await statusOf(person, `/api/forms/${formA.id}/responses`),
      'In Organisation A this person holds „Antworten ansehen".',
    ).toBe(200);
    expect(
      await statusOf(person, `/api/forms/${formA.id}/export.csv`),
      'In Organisation A this person holds „Export".',
    ).toBe(200);

    await switchTenant(person, TENANT_B.name);
    await expect(
      person.getByRole('article').filter({ hasText: formB.title }),
    ).toHaveCount(1);
    expect(
      await statusOf(person, `/api/forms/${formB.id}/responses`),
      'In Organisation B the same person still holds „Antworten ansehen".',
    ).toBe(200);
    expect(
      await statusOf(person, `/api/forms/${formB.id}/export.csv`),
      'In Organisation B the same person holds **no** Export — the whole point of the ' +
        'two memberships being different.',
    ).toBe(403);

    /*
     * …and the same asymmetry on the surface, measured on the form nav rather
     * than on a status code: in Organisation A this person holds „Einstellungen", so
     * the subheader of a form offers the settings and the mail log; in
     * Organisation B the same person, on the same kind of page, is offered neither.
     * The organisation switcher is the only thing that changed between the two reads.
     */
    /*
     * **A second finding from this run, measured here and deliberately not asserted.**
     *
     * The surface offers this person, in Organisation B, three things the server then
     * refuses: „Name des neuen Formulars" plus „+ Neues Formular" on the
     * dashboard (measured: control present, `POST /api/forms` → **403**), the
     * Export control in the responses view, and „Zum Builder" — although the
     * group carries only „Antworten ansehen". `apps/web` never reads `canBuild`
     * or `canExport` anywhere (only `canViewResponses`, `canManageSettings` and
     * `canManageUsers` reach `formNavEntries`), so the two rights exist on the
     * server and on the group editor's pills and nowhere else in the interface.
     *
     * The enforcement is correct — this is not a hole — but it is exactly the
     * the requirement states: „ein Bedienelement, das nichts tut, verspricht
     * trotzdem eine Funktion". A multi-Organisation installation is where it stops being
     * theoretical, because the same person now meets both answers.
     *
     * The walkthrough deliberately did **not** assert the wrong behaviour it
     * found here — an assertion on a defect has to be inverted by whoever
     * fixes it, which is how a suite ends up defending one. It was written
     * down in the worklog instead
     * (`docs/worklog/2026-07-31-m3-d4-dod-mehrere-buende.md`, finding 2), and
     * this is the assertion that arrived **with** the fix: without `can_build`
     * the door is not listed at all. A navigation is a list of doors, and a
     * listed locked one is worse than a missing one.
     */
    await person.goto(`/forms/${formB.id}`);
    const navInB = person.getByRole('navigation', {
      name: 'Aktuelles Formular',
    });
    await expect(
      navInB.getByRole('button', { name: 'Bearbeiten' }),
    ).toHaveCount(0);
    // …and the navigation itself is still there, carried by „Antworten" —
    // the person may read them, which is exactly the group they hold in B.
    await expect(
      navInB.getByRole('button', { name: 'Antworten' }),
    ).toBeVisible();
    await expect(
      navInB.getByRole('button', { name: 'Formular-Einstellungen' }),
    ).toHaveCount(0);
    await expect(
      navInB.getByRole('button', { name: 'E-Mail-Versandprotokoll' }),
    ).toHaveCount(0);

    await switchTenant(person, TENANT_A.name);
    await person.goto(`/forms/${formA.id}`);
    const navInA = person.getByRole('navigation', {
      name: 'Aktuelles Formular',
    });
    await expect(
      navInA.getByRole('button', { name: 'Formular-Einstellungen' }),
    ).toBeVisible();
    await expect(
      navInA.getByRole('button', { name: 'E-Mail-Versandprotokoll' }),
    ).toBeVisible();
  } finally {
    await personContext.close();
  }
});

/* --- Schritt 3b: the SSO path --------------------------------------------- */

test('Schritt 3b — Organisation B trägt einen eigenen OIDC-Provider ein, eine eingeladene Person meldet sich über ihn an, ein verfälschter Rücksprung nicht, und ausgeschaltet ist der Weg abwesend *und* verschlossen', async ({
  browser,
}) => {
  test.setTimeout(240_000);

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();

  try {
    // --- organisation B enters its provider --------------------------------------
    await switchTenant(admin, TENANT_B.name);
    await admin.goto(TENANT_APPEARANCE_PATH);
    const oidcCard = admin.getByRole('region', {
      name: 'Anmeldung (OIDC / SSO)',
    });
    await expect(oidcCard).toBeVisible();

    const offerSso = oidcCard.getByRole('switch', {
      name: 'SSO-Anmeldung anbieten',
      exact: true,
    });
    await offerSso.click();
    await expect(offerSso).toBeChecked();
    await oidcCard.getByLabel('Issuer / Discovery-URL').fill(idp.issuer);
    await oidcCard.getByLabel('Client-ID').fill(OIDC_CLIENT_ID);
    await oidcCard.getByLabel('Scopes').fill('openid email');
    await oidcCard.getByLabel('Button-Beschriftung').fill(SSO_BUTTON);
    await oidcCard
      .getByLabel('Client-Secret ersetzen')
      .fill(OIDC_CLIENT_SECRET);
    await save(oidcCard);

    // The secret went in and does not come back — „gesetzt", never the value.
    await admin.reload();
    await expect(
      admin
        .getByRole('region', { name: 'Anmeldung (OIDC / SSO)' })
        .getByText('Client-Secret ist gesetzt.'),
    ).toBeVisible();
    await expect(
      admin
        .getByRole('region', { name: 'Anmeldung (OIDC / SSO)' })
        .getByLabel('Client-Secret ersetzen'),
    ).toHaveValue('');

    // --- and invites a person who may use it ------------------------------
    /*
     * „Anmelden verleiht keine Rechte" (ADR-0012 no. 5): a token alone opens
     * nothing, the address has to have been invited by *this* Organisation. The
     * „OIDC-Konto (SSO)" option only appears because the block above was
     * saved — with SSO off it is locked, so this is also the
     * proof that the two halves of the tab really talk to each other.
     */
    await admin.goto(TENANT_MEMBERS_PATH);
    const invite = admin.getByRole('region', { name: 'Person hinzufügen' });
    await expect(invite).toBeVisible();
    await invite.getByRole('button', { name: 'OIDC-Konto (SSO)' }).click();
    await invite.getByLabel('Name', { exact: true }).fill(SSO_NAME);
    await invite.getByLabel('E-Mail-Adresse', { exact: true }).fill(SSO_EMAIL);
    await invite
      .getByLabel('Rolle', { exact: true })
      .selectOption({ label: GROUP_B });
    await invite.getByRole('button', { name: 'Hinzufügen' }).click();
    /*
     * **An SSO account gets a mail too** (ADR-0024) — without a link, because
     * there is no password to set. What it achieves is the one piece of
     * information nobody else gives: that this account exists and through
     * which control one gets in. It goes over the instance's mail server, so
     * this branch needs a configured one as well.
     */
    await expect(
      admin.getByText(
        `✓ ${SSO_NAME} wurde hinzugefügt und hat eine Einladung per Mail bekommen.`,
      ),
    ).toBeVisible();
    await expect(
      admin.getByRole('listitem').filter({ hasText: SSO_EMAIL }),
    ).toContainText('Eingeladen');

    // --- the sign-in page offers exactly this one path --------------------
    await guest.goto('/');
    await expectLoginView(guest);
    /*
     * A **link**, not a button: the entry is an `<a href>` to the start route
     * (`LoginView`), because the way to a provider is a full page load and not
     * a fetch. Querying it by the wrong role is how „der Knopf ist da" and
     * „der Knopf fehlt" become the same green.
     */
    await expect(
      guest.getByRole('link', { name: SSO_BUTTON }),
      'The login page offers the organisation’s own entry, captioned with the text ' +
        'that organisation typed.',
    ).toBeVisible();

    const offers: unknown = await (
      await guest.request.get('/api/auth/oidc/providers')
    ).json();
    const offeringTenants = asArray(offers).map((offer) =>
      String(property(offer, 'tenantId')),
    );
    expect(offeringTenants).toContain(await tenantIdOf(admin, TENANT_B.name));
    expect(
      offeringTenants,
      'Organisation A configured no provider, so it contributes no entry — the list is ' +
        'of the organisations that **offer** SSO, not of the Organisationen.',
    ).not.toContain(await tenantIdOf(admin, TENANT_A.name));

    /*
     * --- the falsified return, **before** the real one --------------------
     *
     * The order is the statement. The same `sub`, the same address, the same
     * still-open invitation as in the successful round trip right below — only
     * `state` is changed by one character on the way back. If this case ran
     * **after** the successful one it would be tautological: the invitation
     * would already be redeemed by then, and the attempt would have to fail
     * anyway, even without any `state` check. This way round it proves both —
     * no session **and** the invitation is untouched —, and the round trip
     * below proves that it was the manipulation and not the identity.
     */
    const tamperedContext = await browser.newContext();
    const tampered = await tamperedContext.newPage();
    try {
      await tampered.goto('/');
      await tampered.getByRole('link', { name: SSO_BUTTON }).click();
      // Waited on the state, never on a timeout: the address below is only
      // read once the provider's page really stands.
      await expect(
        tampered.getByRole('heading', { name: IDP_HEADING }),
      ).toBeVisible();

      /*
       * The browser now stands at the provider, and the application has given
       * it its transaction cookie. All that is missing for this return to
       * succeed is a code — and the same provider issues it, through the same
       * method the API suite uses (`@formsache/test-idp`).
       *
       * **Why the return is made by hand and the form is not submitted.** The
       * first attempt hung a `page.route` interception into the return and
       * changed `state` there. Measured result: the interception does not take
       * effect on a *redirected* navigation step, the return ran through
       * unchanged — **and the person was signed in**. A case that claims a
       * manipulation which does not take place at all is worse than none. This
       * version falsifies the address where the browser really goes to it.
       */
      const authorizationUrl = tampered.url();
      const returnedState = new URL(authorizationUrl).searchParams.get('state');
      const code = idp.authorize(authorizationUrl, {
        sub: SSO_SUBJECT,
        email: SSO_EMAIL,
        emailVerified: true,
      });
      /*
       * **What it fails at, not only *that* it fails.** `sso=fehl-
       * geschlagen` is the same return code for a dead provider, a rejected
       * token exchange and a foreign `state` (`oidc-login.service.ts`,
       * `finish`) — so the message on the sign-in page alone only proves
       * „something went wrong". The counter of the token endpoint separates
       * the cases: if it stays **unchanged** across the return, the code was
       * never redeemed, and that is exactly what the check says of itself
       * („before anything is fetched and before a code is spent"). Token
       * exchange and PKCE are thereby named here instead of merely being
       * covered implicitly.
       */
      const tokenRequestsBefore = idp.tokenRequests();
      await tampered.goto(
        `/api/auth/oidc/callback?code=${encodeURIComponent(code)}` +
          `&state=${encodeURIComponent(tamperState(returnedState ?? ''))}`,
      );

      expect(
        idp.tokenRequests(),
        'Der `state` wird geprüft, **bevor** irgendetwas geholt wird: ein ' +
          'Rücksprung mit fremdem `state` löst keinen Token-Tausch aus. Wäre ' +
          'der Zähler gewachsen, hätte die Anwendung den Code eingelöst und ' +
          'erst später abgelehnt — ein anderer Fehlschlag mit derselben ' +
          'Meldung.',
      ).toBe(tokenRequestsBefore);

      await expectLoginView(tampered);
      await expect(
        tampered.getByText(
          'Die Anmeldung über SSO ist fehlgeschlagen. Bitte versuche es erneut.',
        ),
        'Ein Rücksprung mit fremdem `state` ist ein Fehlschlag, und die ' +
          'Anmeldeseite sagt es.',
      ).toBeVisible();
      expect(
        await statusOf(tampered, '/api/auth/me'),
        'Nach dem verfälschten Rücksprung hält dieser Browser keine Sitzung.',
      ).toBe(401);
    } finally {
      await tamperedContext.close();
    }

    // And the invitation has **not** been used up.
    await admin.goto(TENANT_MEMBERS_PATH);
    await expect(
      admin.getByRole('listitem').filter({ hasText: SSO_EMAIL }),
      'Ein abgewiesener Rücksprung löst keine Einladung ein.',
    ).toContainText('Eingeladen');

    /*
     * --- the whole round trip over the surface ----------------------------
     *
     * A context of its own, not `guest`: this one ends up **signed in**, and
     * `guest` is still needed below as a session-less browser, to prove that
     * the button disappears after the switch-off.
     */
    const ssoContext = await browser.newContext();
    const sso = await ssoContext.newPage();
    /*
     * The counter-evidence to the counter above: „unchanged" would be
     * worthless if this counter never grew. Here it has to grow — the same
     * provider, the same method, a round trip that gets as far as the token
     * exchange.
     */
    const tokenRequestsBeforeRoundTrip = idp.tokenRequests();
    try {
      await sso.goto('/');
      await sso.getByRole('link', { name: SSO_BUTTON }).click();

      // At the provider — a foreign origin, not this application.
      await expect(
        sso.getByRole('heading', { name: IDP_HEADING }),
      ).toBeVisible();
      expect(
        new URL(sso.url()).origin,
        'Der Klick führt zum Provider der Organisation, nicht zurück in die Anwendung.',
      ).toBe(idp.origin);

      await signInAtProvider(sso, SSO_SUBJECT, SSO_EMAIL);

      // …and back, signed in.
      await expectDashboard(sso);
      expect(
        idp.tokenRequests(),
        'Der geglückte Rundlauf hat den Code wirklich gegen ein Token ' +
          'getauscht — inklusive `code_verifier`, denn dieser Provider ' +
          'verlangt PKCE und wiese den Tausch sonst ab.',
      ).toBe(tokenRequestsBeforeRoundTrip + 1);
      expect(new URL(sso.url()).origin).toBe(new URL(webBaseUrl).origin);
      await expect(
        sso.getByRole('main').getByText(`Alle Formulare von ${TENANT_B.name}`),
        'Angemeldet **in Organisation B** — die Organisation kommt aus der Einladung, nicht ' +
          'aus dem Token (ADR-0012 Nr. 5).',
      ).toBeVisible();

      const me: unknown = await (await sso.request.get('/api/auth/me')).json();
      expect(property(me, 'email')).toBe(SSO_EMAIL);
      expect(
        property(me, 'isSuperadmin'),
        'Anmelden verleiht keine Rechte: der Weg über SSO macht niemanden zum ' +
          'Superadmin.',
      ).toBe(false);
    } finally {
      await ssoContext.close();
    }

    // --- and the invitation is redeemed -----------------------------------
    await admin.goto(TENANT_MEMBERS_PATH);
    const redeemed = admin.getByRole('listitem').filter({ hasText: SSO_EMAIL });
    await expect(
      redeemed,
      'Nach der ersten Anmeldung ist die Person ein OIDC-Konto, kein offener ' +
        'Vorgang mehr.',
    ).toContainText('OIDC');
    await expect(redeemed).not.toContainText('Eingeladen');
  } finally {
    /*
     * --- absent *and* locked, and at the same time the cleanup ------------
     *
     * An organisation left offering a button would be residue with a visible face —
     * every later run of `auth-flow.spec.ts` would meet it on the login page.
     * Switching it off is therefore both the cleanup and the second half of
     * the proof: the button goes **and** the route refuses when called by
     * hand (the specification — the surface is comfort, the server decides).
     */
    const tenantIdB = await tenantIdOf(admin, TENANT_B.name);

    await admin.goto(TENANT_APPEARANCE_PATH);
    const oidcCard = admin.getByRole('region', {
      name: 'Anmeldung (OIDC / SSO)',
    });
    await oidcCard
      .getByRole('switch', { name: 'SSO-Anmeldung anbieten', exact: true })
      .click();
    await save(oidcCard);

    await guest.goto('/');
    await expectLoginView(guest);
    await expect(guest.getByRole('link', { name: SSO_BUTTON })).toHaveCount(0);
    /*
     * „Verschlossen" is measured on **where** the route sends the browser, not
     * on the status: `start` answers 302 either way — that is the shape of the
     * refusal, and it is deliberate (`oidc-login.controller.ts`: a failure goes
     * back to the application's own outcome page rather than leaving a bare
     * error in the browser). What must never happen is a redirect **to the
     * provider**, so that is what is asserted.
     *
     * **Since then that is a distinction and no longer a claim.** As long as
     * the issuer was a dead address, „not redirected to the provider" also
     * only meant „the provider was never reachable" — both ended in
     * `fehlgeschlagen`. The same provider carried a complete sign-in procedure
     * above in this case; that the same route no longer addresses it now is
     * down to the switch being off.
     */
    const refused = await guest.request.get(
      `/api/auth/oidc/start/${tenantIdB}`,
      { maxRedirects: 0 },
    );
    expect(refused.status()).toBe(302);
    const refusedTo = refused.headers().location ?? '';
    expect(refusedTo).not.toContain(idp.origin);
    expect(
      refusedTo.startsWith(webBaseUrl),
      `An organisation with SSO switched off must be sent back into the application, ` +
        `never on to a provider. Location was: ${refusedTo}`,
    ).toBe(true);

    await guestContext.close();
  }
});

/* --- Schritt 4 ------------------------------------------------------------ */

test('Schritt 4 — einem Bearbeiter wird der Zugriff auf ein Formular entzogen: weder Antworten noch Export', async ({
  browser,
}) => {
  test.setTimeout(240_000);

  await switchTenant(admin, TENANT_A.name);
  controlFormA = await buildForm(admin, 'the acceptance run A Kontrolle');

  const personContext = await browser.newContext();
  const person = await personContext.newPage();
  try {
    await person.goto('/');
    await expectLoginView(person);
    expect(
      await submitLogin(person, {
        email: PERSON.email,
        password: PERSON.password,
      }),
    ).toBe(200);
    await switchTenant(person, TENANT_A.name);

    // The positive control: before the revocation both forms answer.
    expect(await statusOf(person, `/api/forms/${formA.id}/responses`)).toBe(
      200,
    );
    expect(
      await statusOf(person, `/api/forms/${controlFormA.id}/export.csv`),
    ).toBe(200);

    // --- the revocation, over the surface ---------------------------------
    await admin.goto(`/forms/${formA.id}/members`);
    await expect(
      admin.getByRole('heading', { name: 'Nutzerrechte', level: 1 }),
    ).toBeVisible();
    const row = admin.getByRole('listitem').filter({ hasText: PERSON.email });
    const accessSwitch = row.getByRole('switch', {
      name: `Zugriff für ${PERSON.name} auf diesem Formular`,
    });
    await expect(accessSwitch).toBeChecked();
    await accessSwitch.click();
    await expect(accessSwitch).not.toBeChecked();
    await row.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(
      row.getByRole('button', { name: 'Speichern', exact: true }),
    ).toHaveCount(0);

    // --- and the open session notices it without a new sign-in ------------
    await person.goto('/');
    await expect(
      person.getByRole('article').filter({ hasText: formA.title }),
      'A revoked form must disappear from the list, not merely refuse its own ' +
        'address — otherwise the row was loaded and only hidden.',
    ).toHaveCount(0);
    await expect(
      person.getByRole('article').filter({ hasText: controlFormA.title }),
    ).toHaveCount(1);

    expect(
      await statusOf(person, `/api/forms/${formA.id}/responses`),
      'Die Antworten des entzogenen Formulars.',
    ).toBe(404);
    expect(
      await statusOf(person, `/api/forms/${formA.id}/export.csv`),
      'Der Export — der Weg, den eine frühere Fassung offen gelassen hatte.',
    ).toBe(404);
    expect(
      await statusOf(person, `/api/forms/${controlFormA.id}/export.csv`),
      'The other form of the same organisation is untouched.',
    ).toBe(200);
  } finally {
    await personContext.close();
  }
});

/* --- Schritt 5 ------------------------------------------------------------ */

/**
 * **Separate mail servers, without inheritance** (ADR-0023).
 *
 * Up to 2026-08-18 this step measured something that no longer exists:
 * „Organisation A sendet über den Mailserver des Systems". That was the
 * situation before ADR-0023 — since then the organisation's mail server is
 * responsible for its form mail **alone**, and an organisation without one of
 * its own inherits none. The application says so to the operator in plain
 * words, and this step now reads exactly that sentence.
 *
 * Three statements, and the third is the one nobody checked before:
 *
 * 1. Organisation B has a server of its own: its confirmation goes out, over
 *    **its** catcher.
 * 2. Organisation A has none: its notice to the office **stays lying**, with
 *    the reason in the row — not „at some point", but until somebody stores a
 *    mail server.
 * 3. The **installation's** mail server carries none of either. It is there
 *    for account mail (invitation, reset, operational notice); that it carries
 *    no form mail of an organisation out over the installation's SPF/DKIM
 *    signature is the security half of ADR-0023 and was proven by no case up
 *    to here.
 *
 * *Measured on 2026-08-18:* `mail_log` carried the row to A's office as
 * `queued`, `attempts: 0`, with `last_error` = „Diese Organisation hat keinen
 * Mailserver eingetragen …". The old case waited 120 s for a „Zugestellt"
 * that, after ADR-0023, can never come. It only came to light on that day
 * because this project depends on `mobile-360x740` and therefore, as long as
 * the mobile cases were red, did not run at all.
 */
test('Schritt 5 — Organisation B sendet über ihren eigenen Mailserver, Organisation A ohne eigenen bleibt in der Warteschlange, und der Mailserver der Installation trägt keine Formularmail', async ({
  browser,
}) => {
  test.setTimeout(420_000);

  // --- organisation B gets an SMTP block of its own and tests it -------------------
  await switchTenant(admin, TENANT_B.name);
  await admin.goto(TENANT_MAIL_PATH);
  await expect(
    admin.getByRole('heading', { name: 'Mailversand' }),
  ).toBeVisible();

  /*
   * **The switch, no longer the pill** (ADR-0023): the choice „über den
   * Mailserver des Systems" no longer exists — an organisation without a block
   * of its own inherits nothing, its post waits. What remains is „Mailserver
   * eingerichtet", and the middle of the switch is the click a person makes.
   */
  const ownServer = admin.getByRole('switch', {
    name: 'Mailserver eingerichtet',
    exact: true,
  });
  await expect(ownServer).not.toBeChecked();
  await ownServer.click();
  await expect(admin.getByLabel('Host')).toBeVisible();
  await admin.getByLabel('Host').fill('127.0.0.1');
  await admin.getByLabel('Port').fill(String(tenantCatcher.port));
  await admin
    .getByLabel('Absenderadresse')
    .fill(`versand@${TENANT_B.shortName.toLowerCase()}.example.invalid`);
  // Same default, same reason as the system block in Schritt 1.
  const tenantTls = admin.getByRole('switch', {
    name: 'Implizites TLS (smtps)',
    exact: true,
  });
  await expect(tenantTls).toBeChecked();
  await tenantTls.click();
  const mailCard = admin.getByRole('region', { name: 'Mailversand' });
  await mailCard
    .getByRole('button', { name: 'Speichern', exact: true })
    .click();
  await expect(
    mailCard.getByText('Gespeichert', { exact: true }),
  ).toBeVisible();

  const beforeTest = tenantCatcher.messages.length;
  await admin.getByRole('button', { name: 'Testmail senden' }).click();
  await expect(
    admin.getByText(`✓ Testmail an ${seedAdmin.email} gesendet.`),
  ).toBeVisible();
  expect(
    tenantCatcher.messages.length,
    'The Testmail has to arrive at the organisation’s **own** server.',
  ).toBe(beforeTest + 1);
  /*
   * „…and nowhere near the system's" is asserted on the **recipient**, not on
   * the system catcher being empty. It is not empty and must not be expected to
   * be: configuring the installation's first mail server in Schritt 1 flushes
   * whatever `mail_log` rows earlier runs of this suite left `queued` — which
   * is the promised behaviour („ausgehende Mails bleiben in der
   * Warteschlange, bis SMTP eingerichtet ist"), and it made this assertion fail
   * once for a reason that had nothing to do with the Testmail.
   */
  expect(
    systemCatcher.messages.flatMap((message) => message.to),
    'The Testmail must not have gone out through the system’s server.',
  ).not.toContain(seedAdmin.email);

  // --- a real confirmation to the participant, over B's server ------------
  await admin.goto(`/forms/${formB.id}`);
  const mailQuestionId = await admin
    .locator('[data-question-id]')
    .nth(1)
    .getAttribute('data-question-id');
  expect(mailQuestionId).not.toBeNull();

  await admin.goto(`/forms/${formB.id}/notifications`);
  await addNotification(admin, {
    name: 'Bestätigung an den Teilnehmer',
    subject: `Ihre Anmeldung zu {{formular}}`,
    body: 'Vielen Dank, Ihre Anmeldung ist eingegangen. {{bearbeiten}}',
    questionId: mailQuestionId ?? '',
  });

  /*
    Up to 2026-08-14 the delivery to the person filling in hung on a second
    switch whose default was **off** — without it the notification above
    produced not a single row. The switch has been dropped without replacement
    (ADR-0011, continuation; finding 24): the configured notification is the
    decision.
  */
  await admin.goto(`/forms/${formB.id}/settings`);
  /*
   * …and „Bearbeiten nach Absenden", from which `{{bearbeiten}}` can resolve an
   * address in the first place: without the permission the placeholder rightly
   * renders to nothing, and a mail built on it would prove nothing at all
   * about the base address from Schritt 1.
   *
   * **Set, not toggled** (review finding 16): the application's default has
   * been „on" since 2026-08-17, but an organisation may have switched it off.
   * A blind `click()` did the one thing or its opposite depending on the
   * starting position — the state is therefore established and then asserted.
   */
  const access = admin.getByRole('region', { name: 'Zugriff & Sicherheit' });
  await access.getByRole('radio', { name: 'Angepasst' }).click();
  const editSwitch = access.getByRole('switch', {
    name: 'Bearbeiten nach Absenden',
  });
  if (!(await editSwitch.isChecked())) {
    await editSwitch.click();
  }
  await expect(editSwitch).toBeChecked();
  await save(admin);

  await fillPublicly(browser, formB, {
    name: 'Berta Baltia',
    email: PARTICIPANT_B2,
  });

  // --- and a notice to organisation A's office, over the system block -------------
  await switchTenant(admin, TENANT_A.name);
  await admin.goto(`/forms/${formA.id}/notifications`);
  await addNotification(admin, {
    name: 'Anmeldung an die Geschäftsstelle',
    subject: `Neue Anmeldung zu {{formular}}`,
    body: 'Es ist eine Anmeldung eingegangen.',
    addresses: OFFICE_A,
  });

  await fillPublicly(browser, formA, {
    name: 'Adelheid Aurelia',
    email: 'adelheid@example.invalid',
  });

  // --- both paths, in the log and at the two servers ----------------------
  /*
    Organisation A **without** a mail server of its own: the row comes into
    being, and it stays standing. What is waited on is a *state* and not a
    clock — the same build as `expectDelivered`, only with the opposite goal.
  */
  /*
    **A poll that includes the reason** — and that is no convenience but the
    order of the application: the row comes into being on submission,
    `last_error` is written only by the worker on its next pass
    (`MAIL_WORKER_INTERVAL_MS`). The log page does not refresh by itself, so
    every attempt has to **reload**, otherwise the repetition checks the same
    old DOM.

    *Measured on 2026-08-18:* three steps stood here at first — wait for the
    row, then „In Warteschlange", then the reason. The first two were green,
    the third ran into its 5 s because it read a page that had been fetched
    before the worker.
  */
  const officeRow = mailRows(admin).filter({ hasText: OFFICE_A });
  await expect
    .poll(
      async () => {
        await admin.goto(`/mail-log/${formA.id}`);
        await expect(
          admin.getByRole('heading', {
            level: 1,
            name: 'E-Mail-Versandprotokoll',
          }),
        ).toBeVisible();
        if ((await officeRow.count()) !== 1) {
          return 'die Zeile fehlt noch';
        }
        return (await officeRow.innerText()).replace(/\s+/gu, ' ');
      },
      {
        message:
          'Die Meldung ans Büro von Organisation A muss im Protokoll stehen — ' +
          'sie entsteht auch ohne Mailserver, denn genau das ist der Zustand, ' +
          'den die Betreiberin sehen soll —, und sie muss **liegen bleiben** ' +
          'und **sagen warum**. „Zugestellt" wäre die Vererbung, die ADR-0023 ' +
          'abgeschafft hat; ein stiller Stau wäre für die Betreiberin nicht ' +
          'von einem Ausfall zu unterscheiden.',
        timeout: 120_000,
        intervals: [1000, 2000, 3000, 5000],
      },
    )
    // What is waited on is the **reason**: it appears last (the worker writes
    // it), and whoever sees it has the row anyway. Waiting on „In
    // Warteschlange" would be too early — that already stands there at
    // creation time, and the check below would run into its timeout again.
    .toContain('keinen Mailserver eingetragen');
  const officeText = (await officeRow.innerText()).replace(/\s+/gu, ' ');
  expect(officeText).toContain('In Warteschlange');
  expect(officeText).toContain('keinen Mailserver eingetragen');

  await switchTenant(admin, TENANT_B.name);
  await expectDelivered(admin, formB.id, 1);
  await expect(mailRows(admin).filter({ hasText: PARTICIPANT_B2 })).toHaveCount(
    1,
  );

  /*
   * The separation itself, and it is the assertion the two catchers exist for:
   * the mail log shows *that* both went out, the two receivers show
   * *which server* each one went out through. One catcher would have made
   * „Organisation B sendet über ihren eigenen" indistinguishable from „alles ging
   * über den System-Block".
   */
  const systemRecipients = systemCatcher.messages.flatMap(
    (message) => message.to,
  );
  const tenantRecipients = tenantCatcher.messages.flatMap(
    (message) => message.to,
  );
  expect(tenantRecipients).toContain(PARTICIPANT_B2);
  expect(
    tenantRecipients,
    'Der Fänger von Organisation B darf nichts von Organisation A tragen.',
  ).not.toContain(OFFICE_A);
  /*
    **The security half of ADR-0023.** The installation's mail server signs
    with its SPF/DKIM; sending an organisation's form mail out over it would
    mean hanging the installation's reputation on a text an organisation
    writes. Both addresses therefore have to stay foreign to it — A's, because
    its message stays lying instead of taking a detour, and B's, because it
    takes its own path.
  */
  expect(
    systemRecipients,
    'Die Meldung ans Büro von A darf **nicht** ersatzweise über den ' +
      'Mailserver der Installation hinausgehen — sie bleibt liegen.',
  ).not.toContain(OFFICE_A);
  expect(systemRecipients).not.toContain(PARTICIPANT_B2);

  // The base address the superadmin typed in Schritt 1 is what the edit link
  // in a real mail is built from — read out of the delivered message.
  const confirmation = tenantCatcher.messages.find((message) =>
    message.to.includes(PARTICIPANT_B2),
  );
  expect(confirmation?.data ?? '').toContain(webBaseUrl);
});

/* --- Schritt 6 ------------------------------------------------------------ */

/**
 * **The inheritance that still exists: organisation → form** (ADR-0011,
 * continuation 2026-08-14).
 *
 * Up to then this step measured the *third* level: the superadmin changed a
 * system default, the card announced beforehand how many organisations and
 * forms that would affect („Gilt sofort für N Organisationen und M
 * Formulare"), and a running form followed. The level is gone, the reach
 * display with it, and `GET /api/admin/system-settings/form-defaults` as well.
 *
 * What remains is the promise the product still gives — and it is measured
 * here on the path no other file takes: **on the public, session-less address
 * of a running form.** `tenant-form-defaults.spec.ts` measures the same
 * inheritance in the builder, i.e. against a form field; here what counts is
 * what a stranger actually gets to see in the browser.
 *
 * Three statements, and the second is the one a one-sided check overlooks:
 *
 * 1. The inheriting form **follows** the organisation's changed default.
 * 2. The form that has **taken over** the section does **not** follow it —
 *    otherwise „Angepasst" would be a label without effect.
 * 3. The restored default of the organisation reaches the inheriting form
 *    again: the inheritance works in **both** directions.
 */
test('Schritt 6 — ein geänderter Standard der Organisation wirkt auf ein laufendes Formular, aber nicht auf eines, das den Abschnitt übernommen hat', async ({
  browser,
}) => {
  test.setTimeout(300_000);

  await switchTenant(admin, TENANT_A.name);

  /**
   * Does the public fill-in form show the mandatory-field hint?
   *
   * A fresh, session-less context per call — that is the assurance and not the
   * plumbing: what is measured is what a stranger sees, not what the signed-in
   * editor sees.
   */
  async function requiredHintShown(form: BuiltForm): Promise<boolean> {
    const guest = await browser.newContext();
    const page = await guest.newPage();
    try {
      await page.goto(form.path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      return (await page.getByRole('note').count()) > 0;
    } finally {
      await guest.close();
    }
  }

  /*
    The second form of the same organisation takes „Darstellung" to itself —
    **before** the organisation's default changes. Exactly this order is the
    case: „taken over" means that the values of right now are frozen and later
    changes by the organisation no longer apply.
  */
  await admin.goto(`/forms/${controlFormA.id}/settings`);
  const formDisplayCard = admin.getByRole('region', { name: 'Darstellung' });
  await formDisplayCard.getByRole('radio', { name: 'Angepasst' }).click();
  await save(admin);

  const inheritingBefore = await requiredHintShown(formA);
  const customisedBefore = await requiredHintShown(controlFormA);

  // --- the organisation's default changes --------------------------------
  await admin.goto(TENANT_FORM_DEFAULTS_PATH);
  const tenantDisplayCard = admin.getByRole('region', { name: 'Darstellung' });
  // Nothing to take over and nothing to unlock (review finding 10): the
  // organisation's defaults are a set of fields that simply stand there.
  const hintSwitch = tenantDisplayCard.getByRole('switch', {
    name: 'Hinweis auf Pflichtfelder',
    exact: true,
  });
  await expect(hintSwitch).toBeEnabled();
  await hintSwitch.click();
  await expect(hintSwitch).toBeChecked({ checked: !inheritingBefore });
  await save(admin);

  try {
    // (1) The inheriting form follows — without anybody having opened it.
    expect(
      await requiredHintShown(formA),
      'Ein geänderter Standard der Organisation muss ein laufendes, nie ' +
        'angefasstes Formular erreichen — auf seiner öffentlichen, ' +
        'sitzungslosen Adresse.',
    ).toBe(!inheritingBefore);

    // (2) And the one that took it over does not follow. Without this half the
    // case would only prove that something changes at all — not that
    // „Angepasst" protects.
    expect(
      await requiredHintShown(controlFormA),
      'Ein Formular, das „Darstellung" übernommen hat, darf dem Standard der ' +
        'Organisation nicht mehr folgen — sonst ist „Angepasst" eine ' +
        'Beschriftung ohne Wirkung.',
    ).toBe(customisedBefore);
  } finally {
    // (3) Back to the value found on arrival — the organisation's shared row
    // stays as this run met it.
    await admin.goto(TENANT_FORM_DEFAULTS_PATH);
    const restore = admin
      .getByRole('region', { name: 'Darstellung' })
      .getByRole('switch', { name: 'Hinweis auf Pflichtfelder', exact: true });
    await expect(restore).toBeEnabled();
    await restore.click();
    await expect(restore).toBeChecked({ checked: inheritingBefore });
    await save(admin);
  }

  expect(
    await requiredHintShown(formA),
    'Der zurückgestellte Standard muss das erbende Formular wieder ' +
      'erreichen — die Vererbung hat in beide Richtungen zu wirken.',
  ).toBe(inheritingBefore);
});

/* --- Schritt 7 ------------------------------------------------------------ */

test('Schritt 7 — ein Budget-Deckel steht im Versandprotokoll, und die Anmeldung steht trotzdem in den Antworten', async ({
  browser,
}) => {
  test.setTimeout(300_000);

  await switchTenant(admin, TENANT_B.name);

  // The budget is a setting like any other — set through the surface, on the
  // form, and small enough that the next submission meets it.
  await admin.goto(`/forms/${formB.id}/settings`);
  const budgetCard = admin.getByRole('region', { name: 'Versandbudget' });
  await budgetCard.getByRole('radio', { name: 'Angepasst' }).click();
  await budgetCard.getByLabel('Mails je Fenster').fill('1');
  await save(admin);

  /*
   * The baseline is taken **after** a row this run knows is there has arrived.
   * `count()` does not auto-wait, so counting straight after the navigation
   * counted the header row of a table whose body had not been fetched yet —
   * and „grew by one" then measured the loading state rather than the
   * submission.
   */
  const responses = admin.getByRole('table').getByRole('row');
  await admin.goto(`/forms/${formB.id}/responses`);
  await expect(responses.filter({ hasText: 'Berta Baltia' })).toHaveCount(1);
  const responsesBefore = await responses.count();

  await fillPublicly(browser, formB, {
    name: 'Cordula Capped',
    email: PARTICIPANT_B,
  });

  // --- the cap is visible --------------------------------------------------
  await admin.goto(`/mail-log/${formB.id}`);
  const capped = mailRows(admin).filter({ hasText: PARTICIPANT_B });
  await expect(capped).toHaveCount(1);
  await expect(capped).toContainText('Fehlgeschlagen');
  await expect(capped).toContainText('Versandbudget erreicht');

  // --- …and the registration is there -------------------------------------
  await admin.goto(`/forms/${formB.id}/responses`);
  await expect(
    responses.filter({ hasText: 'Cordula Capped' }),
    'The submission that hit the cap must still be an answer — a budget that ' +
      'loses registrations is the outage the sending budget exists to prevent.',
  ).toHaveCount(1);
  expect(await responses.count()).toBe(responsesBefore + 1);
});

/* --- Schritt 8 ------------------------------------------------------------ */

test('Schritt 8 — die Isolationsprobe von Hand: jede ID aus Organisation B antwortet in Organisation A genau wie eine erfundene', async () => {
  test.setTimeout(240_000);

  // --- collect ids from organisation B while the session is there ------------------
  await switchTenant(admin, TENANT_B.name);

  /*
   * A person who is in Organisation B and **nowhere else**, added here on purpose.
   *
   * Measured rather than assumed: the first attempt took `members[0]`, which
   * is the superadmin — who is a member of Organisation A as well — and the probe came
   * back **200**, correctly. „Nutzer aus Organisation B" only means anything if the
   * person is not also somebody Organisation A is entitled to see, and neither of Organisation
   * B's two existing members qualifies (the superadmin created both organisations, the
   * double member of Schritt 3 is deliberately in both). A probe that picks the
   * wrong row measures the wrong boundary — the fixture trap * by header, one layer over.
   */
  await admin.goto(TENANT_MEMBERS_PATH);
  const inviteB = admin.getByRole('region', { name: 'Person hinzufügen' });
  await expect(inviteB).toBeVisible();
  await inviteB.getByLabel('Name', { exact: true }).fill(EXCLUSIVE.name);
  await inviteB
    .getByLabel('E-Mail-Adresse', { exact: true })
    .fill(EXCLUSIVE.email);
  /*
   * **Without a password and without redeeming** (ADR-0024): only their
   * identifier is taken from this person, they never sign in during this run.
   * An account with an open invitation is exactly that — an account —, and the
   * isolation probe asks about its visibility, not about its password.
   */
  await inviteB.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(
    admin.getByText(
      `✓ ${EXCLUSIVE.name} wurde hinzugefügt und hat eine Einladung per Mail bekommen.`,
    ),
  ).toBeVisible();

  const usersBody: unknown = await (
    await admin.request.get('/api/tenant/users')
  ).json();
  // `userId`, not `id`: the list is of **memberships**, and the distinction is
  // exactly what the evidence rests on (`tenantMemberSchema`).
  const foreignUserId = property(
    asArray(property(usersBody, 'members')).find(
      (member) => property(member, 'email') === EXCLUSIVE.email,
    ),
    'userId',
  );
  expect(typeof foreignUserId, 'a user who is only in Organisation B').toBe(
    'string',
  );

  const groupsBody: unknown = await (
    await admin.request.get('/api/tenant/groups')
  ).json();
  const foreignGroupId = property(
    asArray(property(groupsBody, 'groups'))[0],
    'id',
  );
  expect(typeof foreignGroupId, 'a group of Organisation B').toBe('string');

  await admin.goto(`/mail-log/${formB.id}`);
  const testId = await mailRows(admin).first().getAttribute('data-testid');
  const foreignMailLogId = (testId ?? '').replace('mail-log-row-', '');
  expect(foreignMailLogId, 'a mail_log row of Organisation B').not.toBe('');

  // --- and then from organisation A into the address bar ---------------------------
  await switchTenant(admin, TENANT_A.name);

  const probes: readonly {
    readonly what: string;
    readonly foreign: string;
    readonly invented: string;
  }[] = [
    {
      what: 'Formular',
      foreign: `/api/forms/${formB.id}`,
      invented: `/api/forms/${INVENTED_ID}`,
    },
    {
      what: 'Antworten',
      foreign: `/api/forms/${formB.id}/responses`,
      invented: `/api/forms/${INVENTED_ID}/responses`,
    },
    {
      what: 'Versandprotokoll',
      foreign: `/api/mail-log/${foreignMailLogId}`,
      invented: `/api/mail-log/${INVENTED_ID}`,
    },
    {
      what: 'Nutzer',
      foreign: `/api/tenant/users/${String(foreignUserId)}`,
      invented: `/api/tenant/users/${INVENTED_ID}`,
    },
    {
      what: 'Gruppe',
      foreign: `/api/groups/${String(foreignGroupId)}`,
      invented: `/api/groups/${INVENTED_ID}`,
    },
  ];

  for (const probe of probes) {
    const real = await answerOf(admin, probe.foreign);
    const fake = await answerOf(admin, probe.invented);
    expect(
      real.status,
      `${probe.what}: an id of another organisation must be a 404, not a 403 — a ` +
        'refusal would confirm the row exists.',
    ).toBe(404);
    expect(
      real.body,
      `${probe.what}: the answer must be byte-identical to the one an invented ` +
        'id gets, or the difference is the leak.',
    ).toBe(fake.body);
  }

  // The same thing where a browser really has an address bar: the builder of a
  // foreign organisation's form refuses instead of rendering it.
  await admin.goto(`/forms/${formB.id}`);
  await expect(admin.getByRole('alert')).toBeVisible();
  await expect(admin.getByLabel('Formularname')).toHaveCount(0);
});
