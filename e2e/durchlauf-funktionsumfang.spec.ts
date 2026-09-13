import { readFile } from 'node:fs/promises';

import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { startFakeIdp, type FakeIdp } from '@formsache/test-idp';

import {
  addQuestion,
  expectDashboard,
  expectLoginView,
  expectSaved,
  newForm,
  publishAndReadPath,
  saveForm,
} from './app-flows';
import { webBaseUrl } from './env';
import { authStateFile, seedAdmin } from './seed-account';
import { startSmtpCatcher, type SmtpCatcher } from './smtp-catcher';

/**
 * **The full run: the prototype's feature set, measured against a real
 * form.**
 *
 * The rules are the same as before, and they are the reason why this run is a
 * browser script at all: **no SQL, no seed trick, no manual grip on the
 * JSONB**. Building, configuring and checking happen exclusively through the
 * interface, with the clicks a person makes. The database is **read** (through
 * the application's own API, under the signed-in session) in order to evidence
 * something — and **never written** in order to produce a state.
 *
 * Two further rules apply to this run:
 *
 * - **`SEED_PUBLIC_BASE_URL` is not used.** `e2e/global-setup.ts` hands the
 *   seed a base address so that the rest of the suite measures against a
 *   configured installation. This run deletes it in step 1 and enters it again
 *   **through the interface** — otherwise the draft link (step 3) and the edit
 *   link (step 5) would hang on an environment variable instead of on a
 *   setting somebody has set.
 * - **Every address ends in `.invalid`** (RFC 2606), and the only mail
 *   recipient of this run is a `node:net` server on the loopback interface.
 *   Nothing leaves this machine.
 *
 * ## Leaving no residue is a precondition, not a courtesy
 *
 * `durchlauf-organisationen` was once banned from `pnpm e2e` because it left two
 * organizations behind per run; `trash.spec.ts` decayed because it checked
 * “the trash is empty”. This run creates **one** organization and lets forms,
 * answers, drafts, templates, files and `mail_log` rows come into being inside
 * it — all of that within this one organization, and that is the reason for the
 * cut: the clean-up in {@link test.afterAll} deletes templates and forms
 * **permanently** (which physically takes attachment bytes and the mail log
 * with it), removes the SSO person from the organization via *Person entfernen*
 * (which physically takes their account with it), then **measures** the residue
 * and finally deletes the organization itself.
 *
 * **The measurement is the point.** A closing assertion that only checks that
 * “the number of **living** organizations afterwards is the one from before”
 * covers a single table that is clean anyway. Measured after a **green** run,
 * both forms, two answers with names and addresses and four `mail_log` rows
 * were left standing (the reason: the silent `count()` in {@link trashForm}).
 * {@link measureResidue} therefore queries the routes that correspond to the
 * tables this run really touches — forms, trash, templates, mail log, members —
 * and the assertion compares **all** the numbers at once.
 *
 * **What a run actually leaves behind**, measured on 2026-08-05 after a full
 * `pnpm e2e`: the deleted organization itself — the `tenant` row with
 * `deleted_at`, its four `group` rows, the one membership of the superadmin who
 * created it, and the sealed OIDC client secret — plus **four `mail_log` rows,
 * all four without recipient, subject and body** (`eraseMailLogLines` on the
 * permanent deletion of the form: the row stays as an operating record, the
 * person goes). `form`, `response`, `form_template`, `response_draft` and the
 * `user` row of the SSO account are **zero**. The system administration's
 * organization overview offers **no** permanent deletion for an organization
 * (only *Wiederherstellen*); the rest above goes after 30 days with the
 * retention period. A named remainder, not a claim of leaving no residue.
 *
 * `afterAll` and not a last `test()`: a case at the end of a
 * `mode: 'serial'` file no longer runs as soon as an earlier one fails — and
 * that is precisely the run that needs its clean-up most urgently. Every phase
 * has its own `try`/`catch` (logged, not swallowed), a `finally` closes
 * contexts, the SMTP catcher and the test IdP even when everything above has
 * thrown.
 *
 * ## Why a project of its own that depends on all the others
 *
 * For the same reason as `durchlauf-organisationen`: this run writes the
 * installation-wide `system_setting` row (base address) and switches the
 * **shared** superadmin session into its own organization via
 * `PUT /api/session/tenant` — both are global state, so it must not run beside
 * anything. Playwright has no “exclusive”, it has project dependencies; naming
 * all the other projects (including `durchlauf-organisationen`) makes this one
 * the last and the only one. See `playwright.config.ts`.
 */

test.describe.configure({ mode: 'serial' });

/* --- what the run builds for itself -------------------------------------- */

const STAMP = Date.now().toString(36).toUpperCase().slice(-6);

const TENANT = {
  shortName: `G1${STAMP}`,
  name: `Organisation Germania ${STAMP}`,
} as const;

/** The organization in which the parked superadmin session is at home. */
const HOME_TENANT = 'Dachorganisation';

const TEMPLATE_NAME = `Jahrestreffen Vorlage ${STAMP}`;

/* --- the form's questions, in one place ----------------------------------- */

const Q = {
  info: 'Hinweise zum Jahrestreffen',
  name: 'Name des Teilnehmers',
  mail: 'E-Mail des Teilnehmers',
  address: 'Anschrift',
  rating: 'Erwartung an das Programm',
  matrix: 'Bewertung der letzten Tagung',
  table: 'Speiseplan je Tag',
  file: 'Nachweis',
  events: 'Veranstaltungen',
  choice: 'Verpflegungswunsch',
  conditional: 'Sonderwunsch',
} as const;

const CHOICE_MEAT = 'Mit Fleisch';
const CHOICE_VEGGIE = 'Vegetarisch';

/** The two Veranstaltungen — the first is the one that is meant to fill up. */
const EVENT_FULL = 'Galaabend';
const EVENT_SPARE = 'Sommerfest';
/** Two seats, so that “full” is reachable in three registrations. */
const EVENT_FULL_LIMIT = 2;

/** Every address of this run is unroutable by construction (RFC 2606). */
const PARTICIPANT_1 = `g1-teilnehmer-1-${STAMP.toLowerCase()}@example.invalid`;
const PARTICIPANT_2 = `g1-teilnehmer-2-${STAMP.toLowerCase()}@example.invalid`;
const PARTICIPANT_3 = `g1-teilnehmer-3-${STAMP.toLowerCase()}@example.invalid`;

/* --- the SSO round trip --------------------------------- */

const OIDC_CLIENT_ID = `formsache-g1-${STAMP.toLowerCase()}`;
const OIDC_CLIENT_SECRET = `${seedAdmin.password}-g1-oidc-secret`;
const SSO_BUTTON = `Mit Germania-SSO anmelden ${STAMP}`;
const SSO_EMAIL = `g1-sso-${STAMP.toLowerCase()}@example.invalid`;
/** The displayed name — it carries the trigger of „Person entfernen". */
const SSO_NAME = 'G1 SSO Mitglied';
const SSO_SUBJECT = `g1-sso-subject-${STAMP.toLowerCase()}`;
/** The heading of the provider's login screen — its own, not ours. */
const IDP_HEADING = 'Anmeldung beim Test-Identitätsanbieter';
/**
 * The return point, **registered with the provider** as with a real one. It is
 * not a choice of this run: `PublicUrlService.oidcCallbackUrl` appends exactly
 * this path to the base address that step 1 enters.
 */
const OIDC_REDIRECT_URI = `${webBaseUrl}/api/auth/oidc/callback`;
const SSO_GROUP = `G1-Lesen ${STAMP}`;

/* --- paths ---------------------------------------------------------------- */

/*
  Two **tabs of one** place since finding 16:
  `/verwaltung/systemeinstellungen/mailserver` and `/verwaltung/superadmin`
  have become `/admin/system/mail` and `/admin/system`. Die alten Adressen gibt
  es nicht mehr: sie wurden bis Review-Runde 4 weitergeleitet, seit dem harten
  Schnitt auf englische Pfade (ADR-0030) nicht mehr (`system-settings.spec.ts`
  measures that); an acceptance run nevertheless goes to the addresses that
  apply.
*/
const SYSTEM_MAIL_PATH = '/admin/system/mail';
const SUPERADMIN_PATH = '/admin/system';
const TENANT_APPEARANCE_PATH = '/admin/appearance';
const TENANT_MEMBERS_PATH = '/admin/members';
const TENANT_MAIL_PATH = '/admin/mail';
const TRASH_PATH = '/admin/trash';

/**
 * **The test specimen for assumption A7 of ADR-0014 no. 5** — the signature
 * check demands `%PDF-` at **offset 0**, no whitespace, no BOM.
 *
 * The byte prefix comes from real device material: output of a multifunction
 * device of 2026-06-30, measured as
 * `25 50 44 46 2d 31 2e 37 0a 25 f6 e4 fc df 0a` — that is `%PDF-1.7\n`
 * followed by the binary marker `%öäüß\n` in Latin-1 bytes that every PDF
 * producer places after the header so that transport paths recognise the file
 * as binary.
 *
 * **The file itself does not come into the repo** — it was a real notice with
 * personal content. What stands here is the measured prefix; everything behind
 * it is **invented**. The property under test is the prefix, not the text:
 * whether the application accepts a file is decided by the first eight bytes
 * (`FILE_SIGNATURE_BYTES`) and by nothing else.
 */
const SCANNER_PDF_PREFIX = Buffer.from([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xf6, 0xe4, 0xfc,
  0xdf, 0x0a,
]);
const SCANNER_PDF = Buffer.concat([
  SCANNER_PDF_PREFIX,
  Buffer.from(
    '1 0 obj\n<< /Type /Catalog >>\nendobj\n' +
      '% erfundener Inhalt, kein Geraetematerial\n' +
      'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
    'latin1',
  ),
]);
const SCANNER_PDF_NAME = 'Scan Bescheinigung.pdf';

/* --- state the steps hand on to one another ------------------------------- */

interface BuiltForm {
  id: string;
  path: string;
  title: string;
}

let adminContext: BrowserContext;
/** The superadmin, on the session `auth.setup.ts` parked. */
let admin: Page;
let catcher: SmtpCatcher;
let idp: FakeIdp;

let form: BuiltForm = { id: '', path: '', title: '' };
/** The second form — created from the run's own template (the evidence). */
let templateForm: BuiltForm | undefined;

/** The base address as it stood in the installation before this run. */
let originalBaseUrl = '';

/**
 * The number of **living** organizations, read **before** step 1 creates its
 * own. `-1` is not a plausible number and can therefore not be mistaken for a
 * measurement.
 */
let tenantsBefore = -1;

/** The edit link of the first answer — step 3 mints it, step 5 uses it. */
let editPath = '';

/* --- small helpers -------------------------------------------------------- */

/** Reads a field out of foreign JSON without forcing a shape on it. */
function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/** The one save bar of a page or card; waits until it has **landed**. */
async function save(scope: Locator | Page): Promise<void> {
  const button = scope.getByRole('button', { name: 'Speichern', exact: true });
  /*
   * **Reachable first, then clicked.** Every save bar of this application
   * disables its button with `isPending || !dirty` — a click on a clean draft
   * therefore waits for an operability that never arrives, and does so until
   * the **test's** own timeout. Measured: resetting the base address to its
   * unchanged value used up the whole `afterAll` frame of 300 s and took all
   * the phases after it with it. This line turns that into a readable failure
   * after seconds — and the callers only save when there is something to save.
   */
  await expect(
    button,
    'Der Speichern-Knopf ist `isPending || !dirty` — steht er still, gibt es ' +
      'nichts zu speichern, und der Klick wartete sonst bis zur Testfrist.',
  ).toBeEnabled();
  await button.click();
  // Not the disabled button: that one is `isPending || !dirty` and therefore
  // already true while the request is still running.
  await expectSaved(scope);
}

/**
 * The *Pflichtfeld* checkbox in the properties panel — **via the role**, not
 * via the label alone.
 *
 * Measured in the first run of this file: as soon as **one** question is marked
 * as mandatory, its card on the canvas carries an asterisk with
 * `aria-label="Pflichtfeld"`, and `getByLabel('Pflichtfeld')` matches two
 * elements from then on. The checkbox is the only one of the two that has a
 * role.
 */
function requiredCheckbox(): Locator {
  return admin.getByRole('checkbox', { name: 'Pflichtfeld', exact: true });
}

/** The id out of a builder address — `/forms/<id>`. */
function formIdOf(url: string): string {
  const id = new URL(url).pathname.split('/')[2];
  expect(id, `[g1] keine Builder-Adresse: ${url}`).toBeTruthy();
  return id ?? '';
}

/**
 * Switches the signed-in session into the organization of this name via the
 * header.
 *
 * Wording and reasoning as in `durchlauf-organisationen.spec.ts`: the row
 * carries a mark, name, short name and group, so its accessible name is a
 * sentence; this run's organization carries a stamp, a substring stays
 * unambiguous.
 */
async function switchTenant(page: Page, tenantName: string): Promise<void> {
  await page.goto('/');
  /*
   * **Waited for the subtitle, not for the heading.** The dashboard's `<h1>`
   * stands there regardless of whether the session already names an
   * organization; only the line below it says *which one* („Alle Formulare von
   * X" or „Keine Organisation ausgewählt.", `DashboardView.tsx`). The `count()` right
   * below waits for nothing — without this edge it would decide on a
   * half-drawn header.
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

/**
 * The number of **living** organizations as the system administration's
 * organization overview shows it — `totals.tenants` out of the same query that
 * carries filter 4.
 */
async function tenantCount(page: Page): Promise<number> {
  const body: unknown = await (
    await page.request.get('/api/admin/tenants')
  ).json();
  return Number(property(property(body, 'totals'), 'tenants'));
}

/** Every row of the mail log — counted, never the table. */
function mailRows(page: Page): Locator {
  return page.locator('[data-testid^="mail-log-row-"]');
}

/**
 * Waits until a form's mail log shows `count` delivered rows. A reload inside
 * `expect.poll`, never a `waitForTimeout`: what is waited for is a **state**,
 * and the polling ends the moment it arrives.
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
          `Das Versandprotokoll von ${formId} muss ${String(count)} zugestellte ` +
          'Zeile(n) zeigen. Bleibt eine auf „In Warteschlange", hat der ' +
          'Mail-Worker sie nie genommen oder der SMTP-Block trifft den ' +
          'Auffangserver dieses Laufs nicht.',
        timeout: 120_000,
        intervals: [1000, 2000, 3000, 5000],
      },
    )
    .toBe(count);
}

/* --- CSV, read the way a spreadsheet would ------------------------------- */

/** Splits a CSV line into fields, honouring RFC 4180 quoting (`csv.ts`). */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char: string = line[index] ?? '';
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ';') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function parseCsv(raw: string): string[][] {
  const withoutBom = raw.startsWith('﻿') ? raw.slice(1) : raw;
  return withoutBom
    .split('\r\n')
    .filter((line) => line !== '')
    .map(splitCsvLine);
}

/**
 * Downloads the CSV export of the open answers view and splits it —
 * **via „Alle Spalten"**.
 *
 * That is not a convenience but the only way in which this step can measure at
 * all what is promised here: the view's default is the **first three**
 * questions plus the timestamp (the specification,
 * `DEFAULT_QUESTION_COLUMNS`), and this run's form has ten column-carrying
 * questions. Without this click, rating, matrix, table, file and Veranstaltung
 * would be missing from the export — and the case would be green because it had
 * found nothing.
 */
async function downloadCsv(page: Page): Promise<string[][]> {
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('radio', { name: /Alle Spalten/u }).check();
  const downloading = page.waitForEvent('download');
  await page.getByRole('link', { name: 'CSV' }).click();
  const download = await downloading;
  const raw = await readFile(await download.path(), 'utf8');
  return parseCsv(raw);
}

/** `COLUMN_LABEL_SEPARATOR` from `packages/shared/src/answer-columns.ts`. */
const COLUMN_SEP = ' — ';

/** All rows as `{ column name: value }`, named after the header row. */
function csvRowsByHeader(rows: string[][]): Record<string, string>[] {
  const [header, ...body] = rows;
  expect(header, 'der Export muss eine Kopfzeile tragen').toBeDefined();
  return body.map((values) => {
    const record: Record<string, string> = {};
    (header ?? []).forEach((label, index) => {
      record[label] = values[index] ?? '';
    });
    return record;
  });
}

/** Opens the form's answers view via the card in the dashboard. */
async function openResponses(page: Page, title: string): Promise<void> {
  await page.goto('/');
  await page
    .getByRole('article')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Antworten' })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: `Antworten · ${title}` }),
  ).toBeVisible();
}

/**
 * Fills in the mandatory entries of a registration in a **session-less**
 * context.
 *
 * Only the mandatory fields and the Veranstaltungen: the rich question types
 * are filled in completely once in step 3, and the registrations of steps 4 and
 * 5 are there for the Veranstaltung, not for the address.
 */
async function fillMandatory(
  page: Page,
  answers: {
    readonly name: string;
    readonly email: string;
    readonly choice: string;
  },
): Promise<void> {
  await page.getByLabel(new RegExp(Q.name, 'u')).fill(answers.name);
  await page.getByLabel(new RegExp(Q.mail, 'u')).fill(answers.email);
  await page
    .getByRole('group', { name: new RegExp(`^${Q.choice}`, 'u') })
    .getByLabel(answers.choice)
    .check();
}

/** Fill in the provider's login screen and submit it. */
async function signInAtProvider(
  page: Page,
  subject: string,
  email: string,
): Promise<void> {
  await page.getByLabel('Kennung (sub)').fill(subject);
  await page.getByLabel('E-Mail-Adresse').fill(email);
  await page.getByRole('button', { name: 'Anmelden' }).click();
}

/* --- set-up --------------------------------------------------------------- */

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext({ storageState: authStateFile });
  admin = await adminContext.newPage();
  catcher = await startSmtpCatcher('g1-Organisation');
  /*
   * Started here and not in step 9, next to the catcher and for its reason: it
   * is the outside world this run needs, it occupies a loopback port, and it
   * has to be closed again whatever a case does. The **API** reaches it over
   * the same port — discovery and token exchange are calls of the server, not
   * of the browser.
   */
  idp = await startFakeIdp(OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, {
    redirectUri: OIDC_REDIRECT_URI,
  });
});

/* --- clean-up ------------------------------------------------------------- */

/** Deletes this run's template via the builder's drawer. */
async function deleteTemplates(): Promise<void> {
  await admin.goto(`/forms/${form.id}`);
  await expect(admin.getByLabel('Formularname')).toBeVisible();
  await admin.getByRole('button', { name: 'Vorlagen & Blöcke' }).click();

  const drawer = admin.getByRole('dialog', { name: 'Vorlagen & Blöcke' });
  await expect(drawer).toBeVisible();

  /*
   * The trigger carries „Vorlage „X" endgültig löschen", the confirmation below
   * it „Endgültig löschen" — two different accessible names, which is why this
   * pair manages without a CSS class. Counting happens before and after every
   * pass: the drawer redraws itself, and “one fewer” is the state that is
   * waited for.
   *
   * **The waiting edge first, then the first `count()`.** The drawer is visible
   * before its list is there („Vorlagen werden geladen…",
   * `TemplateDrawer.tsx`), and `count()` waits for nothing: without this line
   * the first pass reads the *empty* list. That the error here has so far only
   * been loud and not silent is owed solely to the `toHaveCount(0)` below the
   * loop — the same construction in {@link trashForm} had none. The number
   * before it is asserted and not read: step 1 creates **one** template, and
   * “found none, so nothing to do” would again be the answer this clean-up must
   * never give.
   */
  await expect(drawer.getByText('Vorlagen werden geladen…')).toHaveCount(0);
  const remove = drawer.getByRole('button', { name: /endgültig löschen$/u });
  await expect(
    remove,
    'Schritt 1 hat genau eine Formular-Vorlage angelegt — steht hier keine, ' +
      'räumt dieses Aufräumen nichts ab und meldete es früher als Erfolg.',
  ).toHaveCount(1);
  for (let guard = 0; guard < 10; guard += 1) {
    const before = await remove.count();
    if (before === 0) {
      break;
    }
    await remove.first().click();
    await drawer
      .getByRole('button', { name: 'Endgültig löschen', exact: true })
      .click();
    await expect(remove).toHaveCount(before - 1);
  }
  await expect(remove).toHaveCount(0);
}

/**
 * Puts a form into the trash via „× Löschen" in the dashboard.
 *
 * Through the interface, not through `DELETE /api/forms/:id`: this run's
 * clean-up is itself a piece of evidence (step 8 and the assertion at the end),
 * and a clean-up along a path other than the one a person takes evidences
 * nothing for exactly that path.
 *
 * **The card is asserted, not counted.** `count()` waits for nothing, and until
 * `forms.isPending` `DashboardView.tsx` draws a „Formulare werden geladen…"
 * **without** an `<article>`: a grip that returns silently on `count() === 0`
 * can read zero hits although the form has long been there — and the run
 * reports green while both forms, two answers along with names and addresses
 * and four `mail_log` rows stay untouched in the database. A silent early exit
 * is the worst of all states in the clean-up of personal data. Whoever gets
 * here has built the form (`form.id !== ''`), so the card **must** be there —
 * and if it is not, a loud failure is the right answer.
 */
async function trashForm(title: string): Promise<void> {
  await admin.goto('/');
  const card = admin.getByRole('article').filter({ hasText: title });
  await expect(
    card,
    `Das Formular „${title}" muss im Dashboard dieser Organisation stehen, sonst ` +
      'legt dieses Aufräumen nichts in den Papierkorb.',
  ).toHaveCount(1);
  await card.getByRole('button', { name: 'Löschen' }).click();
  await card.getByRole('button', { name: 'In den Papierkorb legen' }).click();
  await expect(card).toHaveCount(0);
}

/**
 * Empties **this** organization's trash.
 *
 * The trash is the one of the organization the shared session currently stands
 * in — the comment here once claimed it belonged exclusively to this run, and
 * did not check it. Had an earlier phase failed with the session in the home
 * organization, this emptying would have hit the **seed organization**,
 * permanently. {@link switchTenant} is therefore the first line: it measures
 * where the session stands, switches if necessary — and throws when this run's
 * organization is not reachable, instead of grabbing next to it.
 *
 * @param expected how many deleted forms have to lie in it beforehand.
 */
async function emptyTrash(expected: number): Promise<void> {
  await switchTenant(admin, TENANT.name);
  await admin.goto(TRASH_PATH);
  await expect(
    admin.getByRole('heading', { name: 'Papierkorb', level: 1 }),
  ).toBeVisible();

  /*
   * **Something has to be in it first.** That was exactly the second finding:
   * “the trash is empty at the end” was green *because* nothing had ever been
   * put into it — the lesson from `trash.spec.ts` that the head of this file
   * writes down, made here a second time. The number before it is therefore
   * asserted and not read.
   */
  await expect(
    admin.getByTestId('trash-deleted-form'),
    `Vor dem Leeren müssen ${String(expected)} gelöschte Formular(e) hier ` +
      'liegen — sonst sagt „danach leer" über das Leeren nichts aus.',
  ).toHaveCount(expected);

  const trigger = admin.getByRole('button', { name: /Papierkorb leeren/u });
  // An empty trash does not offer the button — that is not a failure but the
  // state this clean-up wants to produce.
  for (let guard = 0; guard < 5 && (await trigger.count()) > 0; guard += 1) {
    await trigger.click();
    await admin
      .getByRole('button', { name: 'Papierkorb leeren', exact: true })
      .click();
    await expect(admin.getByTestId('trash-empty-result')).toBeVisible();
    await admin.reload();
  }

  await expect(
    admin.getByTestId('trash-deleted-form'),
    'Nach dem Leeren steht kein gelöschtes Formular mehr im Papierkorb.',
  ).toHaveCount(0);
  await expect(
    admin.getByText('Papierkorb ist leer'),
    'Der Papierkorb dieser Organisation gehört diesem Lauf allein — er muss am Ende ' +
      'leer sein, und „leer" ist hier eine Messung und keine Annahme.',
  ).toBeVisible();
}

/**
 * What this run's organization **still carries** at the end — per table that
 * the run really touches, read through the application's own routes.
 *
 * The earlier closing assertion counted only the **living organizations** and
 * thereby claimed freedom from residue over the one table that was clean
 * anyway: it saw neither the two forms the broken {@link trashForm} left
 * standing, nor their answers, nor the `mail_log` rows with a recipient
 * address. This measurement goes over the tables that matter.
 */
interface Residue {
  readonly forms: number;
  readonly trashedForms: number;
  readonly trashedResponses: number;
  readonly templates: number;
  readonly mails: number;
  /**
   * How many **form-bound** rows still carry an address. The rows themselves
   * stay standing deliberately (the mail log is the operating record) — what
   * has to go is the person inside them. That is the promise, and it is
   * **zero**.
   */
  readonly formMailsWithRecipient: number;
  /**
   * And how many rows **without** a form still carry an address.
   *
   * Counted separately since ADR-0024 has accounts come into being by
   * invitation: an invitation is a mail to a person, it hangs on **no** form,
   * and `eraseMailLogLines` is called only by `purgeForm` and by the permanent
   * deletion of an answer. It therefore stays standing at this point — and that
   * is not residue but the **other** rule: `mail_log.tenant_id` is
   * `ON DELETE CASCADE` (looked up at the database on 2026-08-18,
   * `confdeltype = 'c'`), so it goes physically with the `tenant` row when the
   * 30-day run deletes the organization permanently. What is measured here is
   * the state **immediately after** the soft deletion, that is in the middle of
   * that period.
   *
   * Added together, this number would have diluted the promise above: “two rows
   * still carry an address” reads the same whether it is a participant or an
   * invited editor. It is not the same thing, so it does not stand in the same
   * number.
   */
  readonly accountMailsWithRecipient: number;
  readonly members: number;
}

/** Counts the elements of a field out of foreign JSON without forcing a shape on it. */
function countOf(value: unknown, key?: string): number {
  const list = key === undefined ? value : property(value, key);
  return Array.isArray(list) ? list.length : Number.NaN;
}

/**
 * Reads the organization's residue **before** it is deleted — afterwards none
 * of it is reachable any more, and that is precisely what the old assertion
 * measured past.
 */
async function measureResidue(): Promise<Residue> {
  await switchTenant(admin, TENANT.name);
  const read = async (path: string): Promise<unknown> => {
    const answer = await admin.request.get(path);
    expect(answer.status(), `[g1] ${path} muss lesbar sein`).toBe(200);
    return answer.json();
  };

  const trash = await read('/api/trash');
  const mailLog = await read('/api/mail-log');
  const entries: unknown = property(mailLog, 'entries');
  return {
    // **`total`, not `items.length`** : since the pagination, `GET /api/forms`
    // answers one page. A residue that counts the loaded page reports at most
    // the page size — and would be blind to exactly the residue that measuring
    // is the point of this function.
    forms: Number(property(await read('/api/forms'), 'total')),
    trashedForms: countOf(trash, 'forms'),
    trashedResponses: countOf(trash, 'responses'),
    templates: countOf(await read('/api/form-templates'), 'templates'),
    mails: Number(property(property(mailLog, 'counts'), 'total')),
    formMailsWithRecipient: Array.isArray(entries)
      ? entries.filter(
          (entry: unknown) =>
            property(entry, 'recipient') !== null &&
            property(entry, 'formId') !== null,
        ).length
      : Number.NaN,
    accountMailsWithRecipient: Array.isArray(entries)
      ? entries.filter(
          (entry: unknown) =>
            property(entry, 'recipient') !== null &&
            property(entry, 'formId') === null,
        ).length
      : Number.NaN,
    members: countOf(await read('/api/tenant/users'), 'members'),
  };
}

/**
 * Removes this run's SSO person from the organization via „Person entfernen" —
 * and with them, because it is their last membership, their account.
 *
 * Idempotent, because it is needed twice: as evidence in step 9 and as a phase
 * of the clean-up should step 9 have broken off beforehand. “Nobody is standing
 * there any more” is therefore a permissible result here — but it is
 * **measured**, not guessed: the waiting edge is the loaded list („Person
 * hinzufügen" is drawn only by the loaded branch of `TenantMembersTab.tsx`),
 * and only after that does a `count()` decide.
 */
async function removeSsoPerson(): Promise<void> {
  await switchTenant(admin, TENANT.name);
  await admin.goto(TENANT_MEMBERS_PATH);
  await expect(
    admin.getByRole('region', { name: 'Person hinzufügen' }),
  ).toBeVisible();

  const person = admin.getByRole('listitem').filter({ hasText: SSO_EMAIL });
  if ((await person.count()) === 0) {
    return;
  }
  await person.getByRole('button', { name: `${SSO_NAME} entfernen` }).click();
  await person.getByRole('button', { name: 'Entfernen', exact: true }).click();
  await expect(person).toHaveCount(0);
}

/** Deletes this run's organization via the system administration's organization overview. */
async function deleteTenant(): Promise<void> {
  await admin.goto(SUPERADMIN_PATH);
  await expect(
    admin.getByRole('heading', {
      name: 'Organisationen dieser Installation',
      level: 2,
    }),
  ).toBeVisible();
  /*
   * The waiting edge before the `count()` below, and it needs a **foreign**
   * row: this grip also runs when step 1 never created its organization (see
   * the phase list), so “not there” is a permissible result here and must not
   * be confused with “not drawn yet”. The home organization stands in every
   * installation that runs this suite at all.
   */
  await expect(
    admin.getByRole('row').filter({ hasText: HOME_TENANT }),
  ).toHaveCount(1);

  const row = admin
    .getByRole('row')
    .filter({ hasText: TENANT.name })
    .filter({
      has: admin.getByRole('button', { name: 'Löschen', exact: true }),
    });
  if ((await row.count()) === 0) {
    return;
  }

  await row.getByRole('button', { name: 'Löschen', exact: true }).click();
  await admin
    .getByLabel('Name der Organisation zur Bestätigung')
    .fill(TENANT.name);
  await admin.getByRole('button', { name: 'Organisation löschen' }).click();
  await expect(row).toHaveCount(0);
}

test.afterAll(async () => {
  /*
   * Not the 30 s of the default. This hook drives a dozen navigations, two
   * delete confirmations and an emptying of the trash through the real
   * application; every *case* of this file demands 180–420 s, and the clean-up
   * is a run of the same kind.
   */
  test.setTimeout(300_000);

  /*
   * **What this run has built, it clears away — what it never built, it does
   * not look for.** `form.id === ''` means: step 1 did not get as far as the
   * form. The three phases before it would then navigate against `/forms/`
   * and run into locator timeouts that evidence nothing — the first run of this
   * file used up the whole `afterAll` frame with exactly that and never reached
   * the *real* phases (base address, delete organization) at all. The
   * organization deletion and the number of living organizations therefore run
   * **always**.
   */
  const builtSomething = form.id !== '';

  /** Filled by the measuring phase below, checked after the loop. */
  let residue: Residue | undefined;

  const phases: readonly (readonly [string, () => Promise<void>])[] = [
    ...(builtSomething
      ? ([
          ['die Vorlagen zu löschen', deleteTemplates],
          [
            'die Formulare in den Papierkorb zu legen',
            async () => {
              await trashForm(form.title);
              if (templateForm !== undefined) {
                await trashForm(templateForm.title);
              }
            },
          ],
          [
            'den Papierkorb zu leeren',
            async () => {
              await emptyTrash(templateForm === undefined ? 1 : 2);
            },
          ],
          ['die SSO-Person zu entfernen', removeSsoPerson],
          [
            'den Rückstand zu messen',
            async () => {
              residue = await measureResidue();
            },
          ],
        ] as const)
      : []),
    [
      'die Basis-Adresse zurückzusetzen',
      async () => {
        await admin.goto(SYSTEM_MAIL_PATH);
        const field = admin
          .getByRole('region', { name: 'Basis-Adresse' })
          .getByRole('textbox', { name: 'Basis-Adresse' });
        await expect(field).toBeVisible();
        const target = originalBaseUrl || webBaseUrl;
        // Only save when something changes: step 1 enters exactly this value,
        // so the normal case is “already right” — and a save without a change
        // is not a save but a silent standstill.
        if ((await field.inputValue()) !== target) {
          await field.fill(target);
          await save(admin);
        }
      },
    ],
    ['die Organisation zu löschen', deleteTenant],
    [
      'in den Heimat-Organisation zurückzuschalten',
      async () => {
        await switchTenant(admin, HOME_TENANT);
      },
    ],
  ];

  for (const [what, run] of phases) {
    const started = Date.now();
    try {
      await run();
    } catch (error) {
      console.error(
        `[g1] Aufräumen: ${what} ist nach ${String(Date.now() - started)} ms gescheitert:`,
        error,
      );
    }
  }

  try {
    /*
     * The assertion, not merely a log line: an `afterAll` that only reports a
     * deviation is the “it looks tidy” against which this clean-up is built.
     *
     * **The tables first, then the organizations.** The number of living
     * organizations alone was the wrong measurement: it was green while two
     * forms, two answers with names and addresses and four `mail_log` rows
     * stood untouched. The comparison against a whole object and not against
     * six individual numbers, so that the failure names **everything** that is
     * left over and not only the first thing.
     */
    if (builtSomething) {
      expect(
        residue,
        'der Rückstand der Organisation muss vor ihrer Löschung gemessen ' +
          'worden sein — ohne Messung ist „nichts übrig" eine Behauptung.',
      ).toEqual({
        forms: 0,
        trashedForms: 0,
        trashedResponses: 0,
        templates: 0,
        /*
         * **Six rows stay, and that is the promise, not the remainder.**
         * Four of them belong to forms, two are invitations (ADR-0024); the
         * split stands at the two numbers below.
         * `purgeForm` calls `eraseMailLogLines` and **empties** recipient,
         * subject and body of every row of this form; the row itself stays,
         * because “how did it turn out and over which mail server” is the
         * operating record this rule expressly leaves standing
         * (`mail_log.form_id` is `ON DELETE SET NULL` for exactly that). The
         * number is therefore not 0 — and the two lines below are the ones that
         * matter.
         */
        mails: 6,
        formMailsWithRecipient: 0,
        /*
         * **Two invitations, and they are waiting for the other rule.** Since
         * ADR-0024 no account comes into being without an invitation; these two
         * rows hang on no form, so `purgeForm` does not touch them.
         * They go physically with the `tenant` row as soon as the 30-day run
         * deletes the organization permanently — `mail_log.tenant_id` is
         * `ON DELETE CASCADE`. This measurement stands **inside** that period.
         *
         * If the number rises, an invitation has been added; if it **falls** to
         * zero, somebody has either abolished the invitation or extended the
         * emptying to rows without a form — both belong looked at before the
         * number here is brought into line.
         */
        accountMailsWithRecipient: 2,
        // The superadmin who created the organization stays its last admin:
        // they cannot remove themselves (`lastAdminMessage`) and go with the
        // organization. The SSO person is the one who could go.
        members: 1,
      });
    }
    expect(
      await tenantCount(admin),
      'die Organisation dieses Laufs muss aus der Zahl der lebenden Organisationen ' +
        'wieder verschwunden sein — die Bedingung dafür, dass diese Datei ' +
        'überhaupt in `pnpm e2e` stehen darf.',
    ).toBe(tenantsBefore);
  } finally {
    /*
     * One `try` per handle, for the reason `durchlauf-organisationen` wrote
     * down: a `beforeAll` that threw while starting the IdP leaves `idp`
     * unassigned, and a throwing `close()` must not take the others with it.
     * `Promise.allSettled` would **not** do it: building the array already
     * evaluates the calls, so the synchronous `TypeError` would escape. Thunks
     * in a loop do.
     */
    const handles: readonly (readonly [string, () => Promise<void>])[] = [
      ['den Superadmin-Kontext', () => adminContext.close()],
      ['den SMTP-Auffangserver', () => catcher.close()],
      ['den Test-IdP', () => idp.close()],
    ];
    for (const [label, close] of handles) {
      try {
        await close();
      } catch (error) {
        console.error(
          `[g1] Aufräumen: ${label} zu schließen scheiterte:`,
          error,
        );
      }
    }
  }
});

/* --- step 1 --------------------------------------------------------------- */

test('Schritt 1 — ein Formular mit allen neuen Fragetypen über den Builder, als eigene Vorlage gespeichert, und aus ihr ein zweites Formular', async () => {
  test.setTimeout(420_000);

  tenantsBefore = await tenantCount(admin);

  // --- base address: cleared and set by hand -------------------------------
  /*
   * This run demands that `SEED_PUBLIC_BASE_URL` is **not** used.
   * `global-setup.ts` hands it to the seed so that the rest of the suite
   * measures against a configured installation — here it is first emptied and
   * then entered through the interface, the way a superadmin would do it.
   * Without that, the draft link from step 3 would hang on an environment
   * variable.
   */
  await admin.goto(SYSTEM_MAIL_PATH);
  const baseUrlField = admin
    .getByRole('region', { name: 'Basis-Adresse' })
    .getByRole('textbox', { name: 'Basis-Adresse' });
  await expect(baseUrlField).toBeVisible();
  originalBaseUrl = await baseUrlField.inputValue();

  await baseUrlField.fill('');
  await save(admin);
  await admin.reload();
  await expect(
    admin
      .getByRole('region', { name: 'Basis-Adresse' })
      .getByRole('textbox', { name: 'Basis-Adresse' }),
  ).toHaveValue('');

  await admin
    .getByRole('region', { name: 'Basis-Adresse' })
    .getByRole('textbox', { name: 'Basis-Adresse' })
    .fill(webBaseUrl);
  await save(admin);
  await admin.reload();
  await expect(
    admin
      .getByRole('region', { name: 'Basis-Adresse' })
      .getByRole('textbox', { name: 'Basis-Adresse' }),
  ).toHaveValue(webBaseUrl);

  // --- one organization, with the superadmin as its first admin (path c) ---
  await admin.goto(SUPERADMIN_PATH);
  await expect(
    admin.getByRole('heading', {
      name: 'Organisationen dieser Installation',
      level: 2,
    }),
  ).toBeVisible();
  await admin.getByRole('button', { name: '+ Neue Organisation' }).click();
  const tenantForm = admin.getByRole('form', { name: 'Neue Organisation' });
  await tenantForm.getByLabel('Kurzname').fill(TENANT.shortName);
  await tenantForm.getByLabel('Name', { exact: true }).fill(TENANT.name);
  await tenantForm.getByLabel('E-Mail des ersten Admins').fill(seedAdmin.email);
  await tenantForm
    .getByLabel('Name des ersten Admins')
    .fill('the acceptance run Superadmin');
  /*
   * **No password any more** (ADR-0024) — and **no invitation** goes out here
   * either: the address is that of the seeded superadmin, so
   * `AdminRepository.createTenant` links the existing account instead of
   * creating one. An existing account knows its password; a second authority
   * for it would be exactly what ADR-0024 does not issue.
   */
  await tenantForm
    .getByRole('button', { name: 'Organisation anlegen' })
    .click();
  await expect(
    admin.getByRole('row').filter({ hasText: TENANT.name }),
  ).toHaveCount(1);
  // An earlier finding, unchanged: the membership stands in the session query,
  // which `useCreateTenant` does not invalidate — a reload is what a person
  // would do next.
  await admin.reload();

  await switchTenant(admin, TENANT.name);

  // --- the organization's own mail server, onto the catcher ----------------
  await admin.goto(TENANT_MAIL_PATH);
  await expect(
    admin.getByRole('heading', { name: 'Mailversand' }),
  ).toBeVisible();
  /*
   * **The switch, no longer the pill** (ADR-0023): the choice „über den
   * Mailserver des Systems" no longer exists — an organization without a block
   * of its own inherits nothing, its mail waits. What remains is „Mailserver
   * eingerichtet", and the middle of the switch is the click a human makes.
   */
  const ownServer = admin.getByRole('switch', {
    name: 'Mailserver eingerichtet',
    exact: true,
  });
  await expect(ownServer).not.toBeChecked();
  await ownServer.click();
  await expect(admin.getByLabel('Host')).toBeVisible();
  await admin.getByLabel('Host').fill('127.0.0.1');
  await admin.getByLabel('Port').fill(String(catcher.port));
  await admin
    .getByLabel('Absenderadresse')
    .fill(`versand@${TENANT.shortName.toLowerCase()}.example.invalid`);
  // „Implizites TLS" is **on** in a fresh block — right for a mail server on
  // the network, wrong for a recipient on loopback.
  const tls = admin.getByRole('switch', {
    name: 'Implizites TLS (smtps)',
    exact: true,
  });
  await expect(tls).toBeChecked();
  await tls.click();
  await save(admin.getByRole('region', { name: 'Mailversand' }));

  // --- the form, question by question through the builder ------------------
  const title = await newForm(
    admin,
    'the acceptance run Jahrestreffen-Anmeldung',
  );
  const id = formIdOf(admin.url());

  await addQuestion(admin, 'Infotext', Q.info);
  await admin
    .getByLabel('Hinweistext')
    .fill('Die Anmeldung ist bis zum Fristende änderbar.');

  await addQuestion(admin, 'Text', Q.name);
  await requiredCheckbox().check();

  await addQuestion(admin, 'E-Mail', Q.mail);
  await requiredCheckbox().check();

  await addQuestion(admin, 'Adresse', Q.address);
  await addQuestion(admin, 'Bewertung', Q.rating);
  await addQuestion(admin, 'Matrix', Q.matrix);
  await addQuestion(admin, 'Tabelle', Q.table);
  await addQuestion(admin, 'Datei-Upload', Q.file);

  /*
   * **The Veranstaltung stands where the old BT template had six number
   * fields** (step 1). Two entries, one of them with an upper limit that is
   * reachable in three registrations — step 4 lets it fill up.
   */
  await addQuestion(admin, 'Veranstaltung', Q.events);
  await admin.getByLabel('Veranstaltung 1', { exact: true }).fill(EVENT_FULL);
  await admin.getByLabel('Veranstaltung 1: Termin').fill('Fr, 19:00');
  await admin
    .getByLabel('Veranstaltung 1: Obergrenze')
    .fill(String(EVENT_FULL_LIMIT));
  await admin.getByLabel('Veranstaltung 1: Restplätze anzeigen').check();
  await admin.getByRole('button', { name: '+ Veranstaltung' }).click();
  await admin.getByLabel('Veranstaltung 2', { exact: true }).fill(EVENT_SPARE);
  await admin.getByLabel('Veranstaltung 2: Termin').fill('Sa, 20:00');
  await admin.getByLabel('Veranstaltung 2: Obergrenze').fill('20');

  await addQuestion(admin, 'Einfachauswahl', Q.choice);
  await admin.getByRole('textbox', { name: 'Option 1' }).fill(CHOICE_MEAT);
  await admin.getByRole('textbox', { name: 'Option 2' }).fill(CHOICE_VEGGIE);
  await requiredCheckbox().check();

  await addQuestion(admin, 'Text', Q.conditional);

  // Page title and description — they belong to the form that step 3 shows to
  // a stranger.
  await admin
    .getByLabel('Titel von Seite 1')
    .fill('Anmeldung zum Jahrestreffen');
  await admin
    .getByLabel('Beschreibung von Seite 1')
    .fill('Bitte für jede Veranstaltung die Teilnehmeranzahl eintragen.');

  await saveForm(admin);
  form = { id, path: '', title };

  // --- save as a template of one's own (the requirement) --------------------
  await admin
    .getByRole('button', { name: 'Formular als Vorlage speichern' })
    .click();
  await admin.getByLabel('Name der Vorlage').fill(TEMPLATE_NAME);
  const savePrompt = admin.getByRole('dialog', {
    name: 'Formular als Vorlage speichern',
  });
  /*
   * Searched inside the dialog, not on the page: „Als Vorlage speichern" is
   * contained as a substring in „Seite als Vorlage speichern", „Formular als
   * Vorlage speichern" and „☆ Als Vorlage speichern" as well — four hits,
   * measured in the first run. The same family as the 54 red cases that
   * `saveForm`'s `exact: true` cleared up.
   */
  await savePrompt
    .getByRole('button', { name: 'Als Vorlage speichern', exact: true })
    .click();
  await expect(
    admin.getByRole('dialog', { name: 'Formular als Vorlage speichern' }),
  ).toHaveCount(0);

  // --- and out of it a second form -----------------------------------------
  await admin.getByRole('button', { name: 'Vorlagen & Blöcke' }).click();
  const drawer = admin.getByRole('dialog', { name: 'Vorlagen & Blöcke' });
  await expect(
    drawer.getByRole('region', { name: 'Komplette Formular-Vorlagen' }),
  ).toBeVisible();
  await drawer
    .getByRole('button', {
      name: new RegExp(`^${TEMPLATE_NAME}.*Neues Formular$`, 'u'),
    })
    .click();

  await expect(admin.getByLabel('Formularname')).toHaveValue(TEMPLATE_NAME);
  const templateFormId = formIdOf(admin.url());
  expect(
    templateFormId,
    'Aus einer Formular-Vorlage entsteht ein **neues** Formular, nicht ein ' +
      'Ersetzen des offenen.',
  ).not.toBe(form.id);
  templateForm = { id: templateFormId, path: '', title: TEMPLATE_NAME };

  /*
   * The actual evidence on a real form: the second one carries **all** the
   * questions of the first. Measured against the builder's cards, not against a
   * number from the API — the template is a copy, and what it copied stands on
   * the canvas.
   */
  for (const label of Object.values(Q)) {
    await expect(
      admin.locator('[data-question-id]').filter({ hasText: label }),
      `Die Vorlage muss „${label}" mitgebracht haben.`,
    ).toHaveCount(1);
  }
});

/* --- step 2 --------------------------------------------------------------- */

test('Schritt 2 — eine bedingte Anzeige, die Einstellungen für Zwischenspeichern und Bearbeiten, eine Benachrichtigung, veröffentlicht', async () => {
  test.setTimeout(300_000);

  await admin.goto(`/forms/${form.id}`);
  await expect(admin.getByLabel('Formularname')).toHaveValue(form.title);

  // --- the conditional display ---------------------------------------------
  const dependent = admin
    .locator('[data-question-id]')
    .filter({ hasText: Q.conditional });
  await dependent.click();
  await admin.getByRole('switch', { name: 'Bedingte Anzeige' }).click();
  await admin
    .getByRole('combobox', { name: 'Frage', exact: true })
    .selectOption({ label: Q.choice });
  await admin
    .getByRole('combobox', { name: 'Bedingung', exact: true })
    .selectOption({ label: 'ist gleich' });
  await admin
    .getByRole('combobox', { name: 'Vergleichswert', exact: true })
    .selectOption({ label: CHOICE_VEGGIE });

  const badge = dependent.getByTestId('question-condition-badge');
  await expect(badge).toHaveText('Bedingt');
  await expect(badge).toHaveAccessibleName(
    new RegExp(`zeigt nur, wenn.*${Q.choice}.*gleich`, 'u'),
  );

  await saveForm(admin);
  form.path = await publishAndReadPath(admin);

  // --- the settings that steps 3 and 5 need --------------------------------
  await admin.goto(`/forms/${form.id}/settings`);
  const access = admin.getByRole('region', { name: 'Zugriff & Sicherheit' });
  await access.getByRole('radio', { name: 'Angepasst' }).check();
  await access
    .getByRole('switch', { name: 'Zwischenspeichern erlauben' })
    .setChecked(true);
  await access
    .getByRole('switch', { name: 'Bearbeiten nach Absenden' })
    .setChecked(true);

  /*
    **No switch for the participant mail any more.** „Nach dem Absenden" used to
    be taken over here only in order to switch „Bestätigung an Teilnehmer
    senden" on — without that, the mail to the person filling in did not come
    into being. The switch has been dropped without replacement (ADR-0011,
    continuation 2026-08-14; finding 24); the notification further down is
    sufficient on its own.

    The section thereby stays on „Tenant-Standard", and for this run that is
    even the more honest picture: the confirmation page that step 5 checks then
    comes from the organization's standards and not from a taking-over that
    existed only for the switch.
  */
  await save(admin);

  // --- a notification to the address out of the answer  ---
  await admin.goto(`/forms/${form.id}`);
  const mailQuestionId = await admin
    .locator('[data-question-id]')
    .filter({ hasText: Q.mail })
    .getAttribute('data-question-id');
  expect(mailQuestionId).not.toBeNull();

  await admin.goto(`/forms/${form.id}/notifications`);
  await admin.getByRole('button', { name: '+ Neue Benachrichtigung' }).click();
  const editor = admin.getByRole('region', { name: 'Benachrichtigung' });
  await editor
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('Bestätigung an den Teilnehmer');
  await editor
    .getByRole('textbox', { name: 'Betreff', exact: true })
    .fill('Ihre Anmeldung zu {{formular}}');
  await editor
    .getByRole('textbox', { name: 'Text', exact: true })
    .fill('Vielen Dank, Ihre Anmeldung ist eingegangen. {{bearbeiten}}');
  await admin.getByTestId(`recipient-question-${mailQuestionId ?? ''}`).click();
  await admin.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(editor.getByText('Gespeichert', { exact: true })).toBeVisible();
});

/* --- step 3 --------------------------------------------------------------- */

test('Schritt 3 — ohne Sitzung ausfüllen: Datei hochladen, Veranstaltung belegen, zwischenspeichern, in einem anderen Kontext fortsetzen und absenden', async ({
  browser,
}) => {
  test.setTimeout(420_000);

  /**
   * The draft's address, in a holder rather than in a pre-assigned variable: a
   * `let draftPath = ''` would have an initial value nobody reads, and exactly
   * therein would lie the trap — should the first context break off before the
   * draft is saved, the second section would carry on against `''` and fail at
   * an address instead of at what was really missing.
   */
  const draft: { path?: string } = {};
  const draftPathOf = (): string => {
    const path = draft.path;
    expect(
      path,
      'Der erste Kontext hat keine Entwurfsadresse hinterlassen — dann misst ' +
        'alles Folgende nicht das Fortsetzen, sondern dessen Ausbleiben.',
    ).toBeDefined();
    return path ?? '';
  };

  // --- the first context: everything except the choice ---------------------
  const firstContext = await browser.newContext();
  const first = await firstContext.newPage();
  try {
    await first.goto(form.path);
    /*
     * Session-less, and that is the assertion, not the setting (the
     * specification).
     *
     * **Measured against something that differs.** An assertion like “there is
     * no *Anmelden* button” would prove nothing: the public fill-in page draws
     * none at all, with *and* without a session. `GET /auth/me` differentiates:
     * 401 without a session, 200 with one. The counter-check on the same route
     * stands next to it, otherwise a typo in the path would evidence the 401
     * just as well.
     */
    expect(
      (await first.request.get('/api/auth/me')).status(),
      'Dieser Kontext trägt keine Sitzung — ein Fremder füllt aus.',
    ).toBe(401);
    expect(
      (await admin.request.get('/api/auth/me')).status(),
      'Gegenprobe: dieselbe Route antwortet unter der geparkten Sitzung 200 — ' +
        'der 401 oben misst die Sitzung und nicht den Pfad.',
    ).toBe(200);
    await expect(
      first.getByRole('heading', {
        level: 2,
        name: 'Anmeldung zum Jahrestreffen',
      }),
    ).toBeVisible();
    await expect(
      first.getByText(
        'Bitte für jede Veranstaltung die Teilnehmeranzahl eintragen.',
      ),
    ).toBeVisible();

    // The info text stands there but has no input field.
    await expect(first.locator('.field__info')).toContainText(Q.info);
    await expect(first.getByLabel(Q.info)).toHaveCount(0);

    // The conditional question is **gone** before the condition is met.
    await expect(first.getByLabel(new RegExp(Q.conditional, 'u'))).toHaveCount(
      0,
    );

    await first.getByLabel(new RegExp(Q.name, 'u')).fill('Anton Anfang');
    await first.getByLabel(new RegExp(Q.mail, 'u')).fill(PARTICIPANT_1);

    await first.getByLabel('Straße & Hausnummer').fill('Musterstraße 1');
    await first.getByLabel('PLZ', { exact: true }).fill('01067');
    await first.getByLabel('Ort', { exact: true }).fill('Dresden');
    await expect(first.getByLabel('Land', { exact: true })).toHaveValue(
      'Deutschland',
    );

    await first.locator('.field__rating-star').nth(2).click();
    await expect(first.getByLabel('3 von 5 Sternen')).toBeChecked();

    const matrix = first.getByRole('group', { name: Q.matrix });
    await matrix.getByLabel('Organisation: Sehr gut').check();
    await matrix.getByLabel('Programm: Gut').check();
    await matrix.getByLabel('Verpflegung: Neutral').check();

    await first.getByLabel('Spalte 1, Zeile 1').fill('Freitag');
    await first.getByLabel('Spalte 2, Zeile 1').fill('Abendessen');
    /*
     * **The reproduction of the formula guard, on a real table cell** (the
     * requirement: „eine Tabellenzelle mit `=1+1` befüllen und exportieren →
     * die Zelle ist geschützt"). It stands here and not in the unit test,
     * because only this path evidences that the guard carries the cell of
     * **this** column: a table hands out a `guard` of its own per cell, and
     * free text in a table cell is the same formula attack as everywhere else.
     */
    await first.getByLabel('Spalte 1, Zeile 2').fill('=1+1');

    /*
     * **The measuring point for assumption A7 of ADR-0014 no. 5.** A test
     * specimen with the byte prefix of a real multifunction device (see
     * {@link SCANNER_PDF_PREFIX}); if it is refused, that is a finding with a
     * file as evidence.
     */
    await first.getByLabel(Q.file).setInputFiles({
      name: SCANNER_PDF_NAME,
      mimeType: 'application/pdf',
      buffer: SCANNER_PDF,
    });
    await expect(
      first.getByText(SCANNER_PDF_NAME),
      'Die Signaturprüfung liest `%PDF-` an Offset 0. Ein Gerät, das Leerraum ' +
        'oder ein BOM voranstellt, würde hier abgewiesen — die Annahme A7 von ' +
        'ADR-0014 Nr. 5 hält für dieses Gerät oder sie hält nicht.',
    ).toBeVisible();

    // The Veranstaltung: one of two seats — and the remaining-seats display is
    // **configurable** (the third of the four deliberate deviations from the
    // prototype): switched on, the number stands there; switched off, nothing
    // does, although the Sommerfest has an upper limit too.
    await expect(
      first.getByText(`${String(EVENT_FULL_LIMIT)} frei`),
    ).toBeVisible();
    await expect(
      first.getByText(/frei$/u),
      'Genau eine der beiden Veranstaltungen zeigt ihre Restplätze — die mit ' +
        'dem Schalter. Der Prototyp zeigt sie immer.',
    ).toHaveCount(1);
    await first.getByLabel(`${EVENT_FULL}: Anzahl Personen`).fill('1');
    await first.getByLabel(`${EVENT_SPARE}: Anzahl Personen`).fill('2');

    // --- save a draft -----------------------------------------------------
    await first.getByRole('button', { name: 'Zwischenspeichern' }).click();
    const draftBlock = first.getByTestId('public-draft-link');
    await expect(draftBlock).toBeVisible();
    const draftUrl = await draftBlock.getByRole('link').getAttribute('href');
    expect(
      draftUrl,
      'Die Adresse des Entwurfs wird vom **Server** gebaut, aus der ' +
        'Basis-Adresse, die Schritt 1 über die Oberfläche eingetragen hat.',
    ).toMatch(/^https?:\/\/[^/]+\/e\/[A-Za-z0-9_-]+$/u);
    draft.path = new URL(draftUrl ?? '').pathname;
  } finally {
    await firstContext.close();
  }

  // --- **another** browser context resumes ---------------------------------
  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  try {
    await second.goto(draftPathOf());
    await expect(second.getByTestId('response-draft')).toBeVisible();
    await expect(second.getByTestId('response-draft-note')).toContainText(
      'zwischengespeicherter Entwurf',
    );

    // What was entered in the first context stands here — attachment included.
    await expect(second.getByLabel(new RegExp(Q.name, 'u'))).toHaveValue(
      'Anton Anfang',
    );
    await expect(second.getByLabel('PLZ', { exact: true })).toHaveValue(
      '01067',
    );
    await expect(second.getByLabel('3 von 5 Sternen')).toBeChecked();
    await expect(
      second.getByLabel(`${EVENT_FULL}: Anzahl Personen`),
    ).toHaveValue('1');
    await expect(
      second.getByText(SCANNER_PDF_NAME),
      'Der Anhang gehört zum Entwurf, nicht zum Browser, der ihn hochgeladen ' +
        'hat — sonst wäre „in einem anderen Kontext fortsetzen" ein Verlust.',
    ).toBeVisible();

    /*
     * **A finding of this run, measured here and deliberately not asserted.**
     *
     * The resumed draft has **no upload door**: `ResponseDraftView` gives
     * `FillIn` no `uploadTarget` („a draft resumed in a different browser
     * context has no upload door of its own yet"), and `FileField` thereupon
     * draws the picker as disabled with the sentence „Datei-Upload steht hier
     * nicht zur Verfügung". That is named and justified.
     *
     * **„Entfernen", however, does not hang on the same condition**
     * (`disabled={busy}`, not `busy || target === undefined`). Whoever opens
     * the draft in the second browser can therefore **take the attachment away
     * and not attach it again** — a door that only goes one way, on exactly the
     * screen step 3 prescribes. Measured on 2026-08-05: picker
     * `disabled = true`, remove button `disabled = false`.
     *
     * **Not asserted**, because an assertion on a defect has to be reversed by
     * whoever fixes it — that is how a suite ends up defending the wrong
     * behaviour. The finding stands in the worklog; what stays asserted here is
     * the promise itself: the attachment **survives** the change of context
     * (above) and goes along on submission (step 6).
     */
    const pickerDisabled = await second.getByLabel(Q.file).isDisabled();
    const removeDisabled = await second
      .getByRole('button', { name: `Entfernen: ${SCANNER_PDF_NAME}` })
      .isDisabled();
    console.info(
      `[g1] Fund 1 — fortgesetzter Entwurf: Auswähler disabled=${String(
        pickerDisabled,
      )}, „Entfernen" disabled=${String(removeDisabled)}`,
    );

    /*
     * **One draft, one address** . A second
     * *Zwischenspeichern* on this page goes as a `PUT` to the same record; were
     * it to mint a new address, the one just noted down would be silently dead
     * — and a person notices that only when they come back.
     */
    await second.getByRole('button', { name: 'Zwischenspeichern' }).click();
    const resumedBlock = second.getByTestId('public-draft-link');
    await expect(resumedBlock).toBeVisible();
    expect(
      new URL((await resumedBlock.getByRole('link').getAttribute('href')) ?? '')
        .pathname,
      'Zwischenspeichern auf der fortgesetzten Seite darf keine zweite Adresse ' +
        'ausgeben — sonst hält der Teilnehmer einen Link in der Hand, der ' +
        'seit dem Speichern auf nichts mehr zeigt.',
    ).toBe(draftPathOf());

    // --- filling on: the choice, and with it the conditional question -----
    const choice = second.getByRole('group', {
      name: new RegExp(`^${Q.choice}`, 'u'),
    });
    await choice.getByLabel(CHOICE_MEAT).check();
    await expect(
      second.getByLabel(new RegExp(Q.conditional, 'u')),
      'Die Bedingung ist „ist gleich Vegetarisch" — bei „Mit Fleisch" bleibt ' +
        'die Frage weg.',
    ).toHaveCount(0);

    await choice.getByLabel(CHOICE_VEGGIE).check();
    const conditional = second.getByLabel(new RegExp(Q.conditional, 'u'));
    await expect(conditional).toBeVisible();
    await conditional.fill('Bitte ohne Zwiebeln.');

    await second.getByRole('button', { name: 'Absenden' }).click();
    await expect(
      second.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
    ).toBeVisible();

    const editUrl = await second
      .getByTestId('public-edit-link')
      .getByRole('link')
      .getAttribute('href');
    expect(editUrl).toMatch(/^https?:\/\/[^/]+\/a\/[A-Za-z0-9_-]+$/u);
    editPath = new URL(editUrl ?? '').pathname;
  } finally {
    await secondContext.close();
  }

  // And the draft is used up: the same address leads to nothing any more.
  const staleContext = await browser.newContext();
  const stale = await staleContext.newPage();
  try {
    await stale.goto(draftPathOf());
    await expect(
      stale.getByTestId('response-draft-unavailable'),
      'Ein abgesendeter Entwurf ist kein Entwurf mehr — sonst läge der halbe ' +
        'Stand einer Person nach dem Absenden weiter offen im Netz.',
    ).toBeVisible();
  } finally {
    await staleContext.close();
  }
});

/* --- step 4 --------------------------------------------------------------- */

test('Schritt 4 — die Veranstaltung läuft voll, der nächste Anmelder wird an genau dieser Position abgewiesen, und die übrige Anmeldung geht durch', async ({
  browser,
}) => {
  test.setTimeout(420_000);

  /*
   * The order is the statement, and it can be produced without any timing: the
   * **later** registrant loads the page while a seat is still free and presses
   * „Absenden" only after another context has taken it. That is exactly the
   * case for which `event_full` carries a position.
   */
  const lateContext = await browser.newContext();
  const late = await lateContext.newPage();
  const rivalContext = await browser.newContext();
  const rival = await rivalContext.newPage();

  try {
    // --- the later registrant fills in while a seat is still free ---------
    await late.goto(form.path);
    await expect(late.getByText('1 frei')).toBeVisible();
    await fillMandatory(late, {
      name: 'Cäsar Spät',
      email: PARTICIPANT_3,
      choice: CHOICE_MEAT,
    });
    await late.getByLabel(`${EVENT_FULL}: Anzahl Personen`).fill('1');
    await late.getByLabel(`${EVENT_SPARE}: Anzahl Personen`).fill('1');

    // --- in between, somebody else takes the last seat ---------------------
    await rival.goto(form.path);
    await fillMandatory(rival, {
      name: 'Bertha Bald',
      email: PARTICIPANT_2,
      choice: CHOICE_MEAT,
    });
    await rival.getByLabel(`${EVENT_FULL}: Anzahl Personen`).fill('1');
    await rival.getByRole('button', { name: 'Absenden' }).click();
    await expect(
      rival.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
    ).toBeVisible();

    // --- and the later one is refused at exactly this position -------------
    await late.getByRole('button', { name: 'Absenden' }).click();
    await expect(
      late.getByText(
        new RegExp(`${EVENT_FULL}.*nicht mehr genügend Plätze`, 'u'),
      ),
      'Die Absage benennt die Veranstaltung und sagt, was zu tun ist — nicht ' +
        '„bitte später wiederkommen", das hier falsch wäre.',
    ).toBeVisible();
    // No confirmation screen: the submission did not go through.
    await expect(
      late.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
    ).toHaveCount(0);
    // The remaining entries still stand — the promise of the message itself.
    await expect(late.getByLabel(new RegExp(Q.name, 'u'))).toHaveValue(
      'Cäsar Spät',
    );
    await expect(
      late.getByLabel(`${EVENT_SPARE}: Anzahl Personen`),
    ).toHaveValue('1');

    // --- reduce the number, and the rest goes through ----------------------
    await late.getByLabel(`${EVENT_FULL}: Anzahl Personen`).fill('');
    await late.getByRole('button', { name: 'Absenden' }).click();
    await expect(
      late.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      'Die übrige Anmeldung geht durch — abgewiesen war eine Position, nicht ' +
        'die Anmeldung.',
    ).toBeVisible();
  } finally {
    await lateContext.close();
    await rivalContext.close();
  }

  // --- and a fresh visitor sees „Ausgebucht" and a locked field ------------
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  try {
    await guest.goto(form.path);
    const full = guest.getByLabel(`${EVENT_FULL}: Anzahl Personen`);
    await expect(full).toHaveAccessibleDescription('Ausgebucht');
    await expect(full).toBeDisabled();
    // The other Veranstaltung is untouched — “fully booked” is a statement
    // about one Veranstaltung, not about the form.
    await expect(
      guest.getByLabel(`${EVENT_SPARE}: Anzahl Personen`),
    ).toBeEnabled();
  } finally {
    await guestContext.close();
  }
});

/* --- step 5 --------------------------------------------------------------- */

test('Schritt 5 — über den Bearbeiten-Link scheitert das Erhöhen der Personenzahl und gelingt das Verringern, das Plätze frei gibt', async ({
  browser,
}) => {
  test.setTimeout(300_000);

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  try {
    await guest.goto(editPath);
    await expect(guest.getByTestId('response-edit')).toBeVisible();
    await expect(guest.getByLabel(new RegExp(Q.name, 'u'))).toHaveValue(
      'Anton Anfang',
    );

    const seats = guest.getByLabel(`${EVENT_FULL}: Anzahl Personen`);
    // Whoever already holds seats may go on operating their own field even when
    // the Veranstaltung is full — otherwise “reducing” would be unreachable.
    await expect(seats).toBeEnabled();
    await expect(seats).toHaveValue('1');

    // --- increasing: refused, because it is full --------------------------
    await seats.fill('2');
    await guest.getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(
      guest.getByText(
        new RegExp(`${EVENT_FULL}.*nicht mehr genügend Plätze`, 'u'),
      ),
    ).toBeVisible();

    // --- reducing: succeeds -----------------------------------------------
    /*
     * **Asserted on the confirmation heading.** An assertion like “the `<h1>`
     * is no longer the form title” is satisfied by the error view as well —
     * “succeeds” would thereby stay green even if the save had failed.
     * `Vielen Dank!` is the default title from `form-settings.ts` that `FillIn`
     * draws after an accepted submission, and only then.
     */
    await seats.fill('');
    await guest.getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(
      guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
      'Ein angenommenes Verringern endet auf dem Bestätigungsbildschirm — ' +
        'nicht bloß auf „irgendeiner anderen Überschrift".',
    ).toBeVisible();
  } finally {
    await guestContext.close();
  }

  // --- and the seat really has become free ---------------------------------
  const afterContext = await browser.newContext();
  const after = await afterContext.newPage();
  try {
    await after.goto(form.path);
    await expect(
      after.getByText('1 frei'),
      'Ein verringerter Eintrag gibt seinen Platz zurück — sonst wäre die ' +
        'Obergrenze ein Zähler, der nur in eine Richtung läuft.',
    ).toBeVisible();
    await expect(
      after.getByLabel(`${EVENT_FULL}: Anzahl Personen`),
    ).toBeEnabled();
  } finally {
    await afterContext.close();
  }
});

/* --- step 6 --------------------------------------------------------------- */

test('Schritt 6 — auswerten und exportieren: die Spalten der neuen Typen stehen wie vorgegeben', async () => {
  test.setTimeout(300_000);

  await openResponses(admin, form.title);
  await expect(admin.getByText('3 Antworten')).toBeVisible();

  // The folded-together cell on screen.
  await expect(
    admin.getByRole('cell', {
      name: 'Musterstraße 1, 01067 Dresden, Deutschland',
    }),
  ).toBeVisible();

  const rows = await downloadCsv(admin);
  const header = rows[0] ?? [];
  const cells = csvRowsByHeader(rows);
  expect(cells).toHaveLength(3);

  const anton = cells.find((row) => row[Q.name] === 'Anton Anfang');
  expect(
    anton,
    'Die Antwort aus Schritt 3 muss im Export stehen.',
  ).toBeDefined();
  const late = cells.find((row) => row[Q.name] === 'Cäsar Spät');
  expect(late).toBeDefined();

  // --- info text: no column, nowhere  ------------------------------
  expect(header.join(';')).not.toContain(Q.info);

  // --- address: four columns, the postcode as text  ----------------
  expect(
    header.filter((label) => label.startsWith(`${Q.address}${COLUMN_SEP}`)),
  ).toStrictEqual([
    `${Q.address}${COLUMN_SEP}Straße & Hausnummer`,
    `${Q.address}${COLUMN_SEP}PLZ`,
    `${Q.address}${COLUMN_SEP}Ort`,
    `${Q.address}${COLUMN_SEP}Land`,
  ]);
  expect(anton?.[`${Q.address}${COLUMN_SEP}PLZ`]).toBe("'01067");
  expect(anton?.[`${Q.address}${COLUMN_SEP}PLZ`]).not.toBe('1067');

  // --- rating: a number, unguarded  --------------------------------
  expect(anton?.[Q.rating]).toBe('3');

  // --- matrix: one column per row  ---------------------------------
  expect(
    header.filter((label) => label.startsWith(`${Q.matrix}${COLUMN_SEP}`)),
  ).toStrictEqual([
    `${Q.matrix}${COLUMN_SEP}Organisation`,
    `${Q.matrix}${COLUMN_SEP}Programm`,
    `${Q.matrix}${COLUMN_SEP}Verpflegung`,
  ]);
  expect(anton?.[`${Q.matrix}${COLUMN_SEP}Organisation`]).toBe('Sehr gut');
  expect(anton?.[`${Q.matrix}${COLUMN_SEP}Programm`]).toBe('Gut');

  // --- table: one column per cell  ---------------------------------
  const tableColumns = header.filter((label) =>
    label.startsWith(`${Q.table}${COLUMN_SEP}`),
  );
  expect(tableColumns, '2 Spalten × 2 Zeilen = 4 Zellen').toHaveLength(4);
  expect(anton?.[`${Q.table}${COLUMN_SEP}Spalte 1 (Zeile 1)`]).toBe('Freitag');
  expect(anton?.[`${Q.table}${COLUMN_SEP}Spalte 2 (Zeile 1)`]).toBe(
    'Abendessen',
  );
  // The untouched cell: empty, not omitted — a fixed set of columns is the
  // whole point of a table.
  expect(anton?.[`${Q.table}${COLUMN_SEP}Spalte 2 (Zeile 2)`]).toBe('');
  // …and the cell with the formula carries the formula guard of **its** column.
  expect(
    anton?.[`${Q.table}${COLUMN_SEP}Spalte 1 (Zeile 2)`],
    'Eine Tabellenzelle mit `=1+1` geht geschützt in die Datei — sonst rechnet ' +
      'die Tabellenkalkulation beim Öffnen los.',
  ).toBe("'=1+1");

  // --- Veranstaltung: one column per entry, with the number of persons ----
  expect(
    header.filter((label) => label.startsWith(`${Q.events}${COLUMN_SEP}`)),
  ).toStrictEqual([
    `${Q.events}${COLUMN_SEP}${EVENT_FULL}`,
    `${Q.events}${COLUMN_SEP}${EVENT_SPARE}`,
  ]);
  // Step 5 gave Anton's seat back, their Sommerfest entry stands.
  expect(anton?.[`${Q.events}${COLUMN_SEP}${EVENT_FULL}`]).toBe('');
  expect(anton?.[`${Q.events}${COLUMN_SEP}${EVENT_SPARE}`]).toBe('2');
  // And the “remaining registration” from step 4 really did go through.
  expect(late?.[`${Q.events}${COLUMN_SEP}${EVENT_SPARE}`]).toBe('1');
  expect(late?.[`${Q.events}${COLUMN_SEP}${EVENT_FULL}`]).toBe('');

  // --- file upload: the name, and no address (ADR-0014 no. 17) -----------
  expect(anton?.[Q.file]).toBe(SCANNER_PDF_NAME);
  expect(rows.flat().join(';')).not.toContain('/api/responses/files/');

  /*
   * …and the **bytes**, once all the way round.
   *
   * The rest of this step reads text; here the file is fetched that a
   * session-less browser uploaded in step 3. This is the only place in this run
   * where the whole path is measured — selection in the foreign browser, saving
   * a draft, submitting from **another** context, the claim
   * (`attachment-claim.ts`), retrieval behind the guard chain — and the
   * evidence that the prefix which passed the signature check comes back out
   * unchanged.
   */
  /*
   * The link is looked for in the **detail view**, not in the table: by default
   * the table shows the first three questions (the specification), and the file
   * is the eighth. To reach for it in the table would mean waiting five minutes
   * for an element that is not supposed to stand there at all — measured, and
   * it is exactly the difference between “not there” and “not shown”.
   */
  await admin
    .getByRole('row')
    .filter({ hasText: 'Anton Anfang' })
    .getByRole('button', { name: 'Ansehen' })
    .click();
  const detail = admin.getByRole('dialog', { name: 'Antwort' });
  await expect(detail).toBeVisible();
  const fileHref = await detail
    .getByRole('link', { name: SCANNER_PDF_NAME })
    .getAttribute('href');
  await detail.getByRole('button', { name: 'Schließen' }).click();
  expect(fileHref).toMatch(/^\/api\/responses\/files\/[A-Za-z0-9_-]+$/u);
  const delivered = await admin.request.get(fileHref ?? '');
  expect(delivered.status()).toBe(200);
  expect(
    delivered.headers()['content-disposition'],
    'Eine Anlage geht ausschließlich als Download hinaus — ' +
      '`inline` machte aus einem fremden PDF eine Seite in unserem Origin.',
  ).toContain('attachment');
  expect(delivered.headers()['x-content-type-options']).toBe('nosniff');
  const deliveredBytes = await delivered.body();
  expect(
    deliveredBytes
      .subarray(0, SCANNER_PDF_PREFIX.length)
      .equals(SCANNER_PDF_PREFIX),
    'Die ausgelieferten Bytes tragen denselben Geräte-Präfix, der bei der ' +
      'Annahme geprüft wurde — `%PDF-` an Offset 0, dann die Binär-Markierung.',
  ).toBe(true);
  expect(deliveredBytes.length).toBe(SCANNER_PDF.length);

  // --- the conditional question: answered only where it was visible ------
  expect(anton?.[Q.conditional]).toBe('Bitte ohne Zwiebeln.');
  expect(
    late?.[Q.conditional],
    'Wer „Mit Fleisch" gewählt hat, hat die Frage nie gesehen — und ihre ' +
      'Zelle ist leer, nicht ausgelassen.',
  ).toBe('');
});

/* --- step 7 --------------------------------------------------------------- */

test('Schritt 7 — eine Antwort in den Papierkorb, wiederhergestellt, endgültig gelöscht — und die Zeile im Versandprotokoll steht ohne personenbezogene Spalten', async () => {
  test.setTimeout(420_000);

  /*
   * --- first the mail really has to be out ------------------------------
   *
   * **Four rows, not three**, and the fourth is the yield of counting: three
   * submissions (step 3, and two in step 4) **plus** the change from step 5. A
   * notification with the trigger „Absenden" goes out again after an edit, with
   * the change block in front of it — whoever expects three here has overlooked
   * this promise, and the server has not broken it.
   */
  await expectDelivered(admin, form.id, 4);
  /*
   * Two rows carry this person's address — their submission and their change.
   * **Asserted, not read:** a `count()` waits for nothing, and the same number
   * carries the second piece of evidence at the end of this case.
   */
  const personalRows = 2;
  await expect(
    mailRows(admin).filter({ hasText: PARTICIPANT_1 }),
    'Die Bestätigung geht an die Adresse aus der Antwort selbst — ' +
      'für diese Person sind es die Absendung und die Änderung.',
  ).toHaveCount(personalRows);
  expect(
    catcher.messages.flatMap((message) => message.to),
    'Und sie ist über den **eigenen** Mailserver der Organisation hinausgegangen.',
  ).toContain(PARTICIPANT_1);

  // --- into the trash ------------------------------------------------------
  await openResponses(admin, form.title);
  const row = admin.getByRole('row').filter({ hasText: 'Anton Anfang' });
  await row.getByRole('button', { name: 'Ansehen' }).click();
  const panel = admin.getByRole('dialog', { name: 'Antwort' });
  await expect(panel).toBeVisible();
  await panel.getByTestId('responses-detail-delete').click();
  await panel.getByRole('button', { name: 'In den Papierkorb legen' }).click();
  await expect(admin.getByRole('cell', { name: 'Anton Anfang' })).toHaveCount(
    0,
  );
  await expect(admin.getByText('2 Antworten')).toBeVisible();

  // --- and back out again --------------------------------------------------
  await admin.goto(TRASH_PATH);
  const trashRow = admin
    .getByTestId('trash-deleted-response')
    .filter({ hasText: form.title });
  await expect(trashRow).toHaveCount(1);
  await trashRow.getByRole('button', { name: 'Wiederherstellen' }).click();
  await expect(trashRow).toHaveCount(0);

  await openResponses(admin, form.title);
  await expect(
    admin.getByRole('cell', { name: 'Anton Anfang' }),
    'Wiederhergestellt heißt: dieselbe Antwort steht wieder in der Tabelle.',
  ).toBeVisible();
  await expect(admin.getByText('3 Antworten')).toBeVisible();

  // --- and permanently gone ------------------------------------------------
  await admin
    .getByRole('row')
    .filter({ hasText: 'Anton Anfang' })
    .getByRole('button', { name: 'Ansehen' })
    .click();
  await admin.getByTestId('responses-detail-delete').click();
  await admin.getByRole('button', { name: 'In den Papierkorb legen' }).click();

  await admin.goto(TRASH_PATH);
  const doomed = admin
    .getByTestId('trash-deleted-response')
    .filter({ hasText: form.title });
  await expect(doomed).toHaveCount(1);
  await doomed.getByRole('button', { name: 'Endgültig löschen' }).click();
  await doomed
    .locator('.trash-row__confirm')
    .getByRole('button', { name: 'Endgültig löschen' })
    .click();
  await expect(doomed).toHaveCount(0);

  // --- the mail log: the row stays, the personal data goes ----------------
  await admin.goto(`/mail-log/${form.id}`);
  await expect(
    admin.getByRole('heading', { level: 1, name: 'E-Mail-Versandprotokoll' }),
  ).toBeVisible();
  await expect(
    mailRows(admin).filter({ hasText: PARTICIPANT_1 }),
    'Nach dem endgültigen Löschen darf die Adresse der Person nirgends mehr ' +
      'im Protokoll stehen.',
  ).toHaveCount(0);
  await expect(
    mailRows(admin).filter({ hasText: '(endgültig gelöscht)' }),
    'Die Zeilen selbst bleiben — „wie ging es aus und über welchen Mailserver" ' +
      'ist der Betriebsnachweis, den das endgültige Löschen ausdrücklich stehen lässt. Es sind ' +
      'genau so viele, wie eben die Adresse trugen: geleert wird die Spalte, ' +
      'nicht die Zeile.',
  ).toHaveCount(personalRows);
});

/* --- step 8 --------------------------------------------------------------- */

test('Schritt 8 — eine Organisation wird gelöscht und wiederhergestellt', async ({
  browser,
}) => {
  test.setTimeout(300_000);

  const live = await tenantCount(admin);
  expect(live).toBe(tenantsBefore + 1);

  await admin.goto(SUPERADMIN_PATH);
  await expect(
    admin.getByRole('heading', {
      name: 'Organisationen dieser Installation',
      level: 2,
    }),
  ).toBeVisible();

  const row = admin
    .getByRole('row')
    .filter({ hasText: TENANT.name })
    .filter({
      has: admin.getByRole('button', { name: 'Löschen', exact: true }),
    });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Löschen', exact: true }).click();

  // The name as confirmation — no clicking straight through.
  const confirm = admin.getByRole('button', { name: 'Organisation löschen' });
  await expect(confirm).toBeDisabled();
  await admin
    .getByLabel('Name der Organisation zur Bestätigung')
    .fill(TENANT.name);
  await confirm.click();
  await expect(row).toHaveCount(0);

  expect(
    await tenantCount(admin),
    'Eine gelöschte Organisation zählt nicht mehr zu den lebenden — dieselbe Zahl, die ' +
      'die Übersicht zeigt und jede andere Spec sieht.',
  ).toBe(tenantsBefore);

  /*
   * **The question only a full run asks: what does an organization's trash do
   * with its public forms?**
   *
   * A deleted organization is gone on the administrative side — but its
   * published form has an address that stands on invitations and in mails, and
   * a stranger without a session calls it. Both answers would be explicable
   * (“deleted means closed” against “restorable for 30 days means: nothing is
   * lost”), but they have to be **decided** and not come out by chance. It is
   * measured at the public read route, not at the rendered page: the
   * single-page application delivers the same HTML with a 200 for every
   * address.
   */
  const publicRoute = `/api/public/forms/${form.path.split('/').pop() ?? ''}`;
  const probeContext = await browser.newContext();
  try {
    const probe = await probeContext.request.get(publicRoute);
    /*
     * **Measured on 2026-08-05: 404.** The form of an organization in the trash
     * is publicly closed — the `deletedAt: null` filter of the tenant chain
     * takes hold for the session-less path as well, and that is the safe one of
     * the two directions: a deleted organization must not collect any more
     * registrations. Asserted so that the opposite direction does not arise
     * unnoticed.
     *
     * **What stays open about it and belongs in the worklog:** the participant
     * who follows the link from their invitation gets the same bare answer as
     * with an invented address, although the organization is restorable for 30
     * days. That is an operating question, not a security hole.
     *
     * **On its own this 404 evidences nothing** — it would have acknowledged a
     * typo in the path just the same. The counter-check therefore stands behind
     * the restoring further down: **the same** address, **the same** context,
     * 200. Only the pair says “the organization's trash closes its form”
     * instead of “something at this address was not there”.
     */
    expect(
      probe.status(),
      'Eine Organisation im Papierkorb sammelt keine Anmeldungen mehr ein.',
    ).toBe(404);
  } finally {
    await probeContext.close();
  }

  // --- and back out again --------------------------------------------------
  const deleted = admin
    .getByTestId('superadmin-deleted-tenant')
    .filter({ hasText: TENANT.name });
  await expect(
    deleted,
    'Eine gelöschte Organisation liegt im Papierkorb, nicht im Nichts.',
  ).toHaveCount(1);
  await deleted.getByRole('button', { name: 'Wiederherstellen' }).click();
  await expect(deleted).toHaveCount(0);

  await expect(
    admin.getByRole('row').filter({ hasText: TENANT.name }),
  ).toHaveCount(1);
  expect(await tenantCount(admin)).toBe(tenantsBefore + 1);

  /*
   * --- the counter-check to the 404 --------------------------------------
   *
   * The same address, again without a session, now at the living organization:
   * 200. That is the half that was missing above — without it the 404 only
   * evidenced that something at `publicRoute` was not there, and a mistyped
   * path would have produced the same green.
   */
  const restoredContext = await browser.newContext();
  try {
    const probe = await restoredContext.request.get(publicRoute);
    expect(
      probe.status(),
      'Wiederhergestellt heißt: das öffentliche Formular ist wieder offen — ' +
        'derselbe Pfad, der eben 404 antwortete.',
    ).toBe(200);
  } finally {
    await restoredContext.close();
  }

  // And the organization really is usable again: its forms are there.
  await switchTenant(admin, TENANT.name);
  await expect(
    admin.getByRole('article').filter({ hasText: form.title }),
  ).toHaveCount(1);
});

/* --- step 9 --------------------------------------------------------------- */

test('Schritt 9 — der SSO-Rundlauf über die Oberfläche: Weiterleitung, Rücksprung, angemeldet, Einladung eingelöst', async ({
  browser,
}) => {
  test.setTimeout(300_000);

  await switchTenant(admin, TENANT.name);

  // --- a group somebody can be invited into -------------------------------
  await admin.goto(TENANT_MEMBERS_PATH);
  await expect(
    admin.getByRole('region', { name: 'Person hinzufügen' }),
  ).toBeVisible();
  await admin.getByRole('button', { name: '+ Gruppe hinzufügen' }).click();
  const fresh = admin
    .locator('.tenant-admin__group-card')
    .filter({ has: admin.getByLabel('Name der Gruppe Neue Gruppe') });
  await expect(fresh).toBeVisible();
  await fresh.getByLabel('Name der Gruppe Neue Gruppe').fill(SSO_GROUP);
  await fresh
    .getByRole('button', { name: 'Antworten ansehen', exact: true })
    .click();
  await fresh.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(
    admin
      .locator('.tenant-admin__group-card')
      .filter({ has: admin.getByLabel(`Name der Gruppe ${SSO_GROUP}`) }),
  ).toBeVisible();

  // --- the organization's provider ----------------------------------------
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
  await oidcCard.getByLabel('Client-Secret ersetzen').fill(OIDC_CLIENT_SECRET);
  await save(oidcCard);

  // --- and an invitation that is allowed to use it ------------------------
  await admin.goto(TENANT_MEMBERS_PATH);
  const invite = admin.getByRole('region', { name: 'Person hinzufügen' });
  await expect(invite).toBeVisible();
  await invite.getByRole('button', { name: 'OIDC-Konto (SSO)' }).click();
  await invite.getByLabel('Name', { exact: true }).fill(SSO_NAME);
  await invite.getByLabel('E-Mail-Adresse', { exact: true }).fill(SSO_EMAIL);
  await invite.getByLabel('Rolle', { exact: true }).selectOption({
    label: SSO_GROUP,
  });
  await invite.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(
    admin.getByRole('listitem').filter({ hasText: SSO_EMAIL }),
  ).toContainText('Eingeladen');

  // --- the round trip, click by click -------------------------------------
  const ssoContext = await browser.newContext();
  const sso = await ssoContext.newPage();
  const tokenRequestsBefore = idp.tokenRequests();
  try {
    await sso.goto('/');
    await expectLoginView(sso);
    /*
     * A **link**, not a button: the way to a provider is a full page change and
     * not a `fetch`. Asking for the wrong role is how “the button is there” and
     * “the button is missing” become the same green.
     */
    await sso.getByRole('link', { name: SSO_BUTTON }).click();

    await expect(sso.getByRole('heading', { name: IDP_HEADING })).toBeVisible();
    expect(
      new URL(sso.url()).origin,
      'Der Klick führt zum Provider der Organisation, nicht zurück in die Anwendung.',
    ).toBe(idp.origin);

    await signInAtProvider(sso, SSO_SUBJECT, SSO_EMAIL);

    await expectDashboard(sso);
    expect(
      idp.tokenRequests(),
      'Der Rundlauf hat den Code wirklich gegen ein Token getauscht — samt ' +
        '`code_verifier`, denn dieser Provider verlangt PKCE.',
    ).toBe(tokenRequestsBefore + 1);
    await expect(
      sso.getByRole('main').getByText(`Alle Formulare von ${TENANT.name}`),
      'Angemeldet **in dieser Organisation** — die Organisation kommt aus der Einladung, nicht ' +
        'aus dem Token (ADR-0012 Nr. 5).',
    ).toBeVisible();

    const me: unknown = await (await sso.request.get('/api/auth/me')).json();
    expect(property(me, 'email')).toBe(SSO_EMAIL);
    expect(
      property(me, 'isSuperadmin'),
      'Anmelden verleiht keine Rechte.',
    ).toBe(false);
  } finally {
    await ssoContext.close();
  }

  // --- and the invitation has been redeemed -------------------------------
  await admin.goto(TENANT_MEMBERS_PATH);
  const redeemed = admin.getByRole('listitem').filter({ hasText: SSO_EMAIL });
  await expect(redeemed).toContainText('OIDC');
  await expect(redeemed).not.toContainText('Eingeladen');

  /*
   * --- and gone again: specification no. 69 on a real account -------------
   *
   * The first report of this run listed “deleting an account” as something the
   * interface cannot do, and the `user` left behind as a named remainder for
   * later. Both were wrong: „Person entfernen" stands in
   * `TenantMembersTab.tsx`, and `deleteHomelessAccount` deletes the `user` row
   * **physically** as soon as the last membership is gone.
   *
   * **What is measured is the deletion, not the disappearance from the list** —
   * whoever has merely lost their membership disappears from that too. The one
   * piece of information the interface gives about the installation-wide stock
   * is adding the same address again: `TenantUsersService.create` attaches an
   * **existing** OIDC account („OIDC", without „Eingeladen"), and only when
   * there is none left does a **new invitation** come into being. „Eingeladen"
   * is therefore the evidence that the row really did go along.
   */
  await removeSsoPerson();
  await admin.goto(TENANT_MEMBERS_PATH);
  const reinvite = admin.getByRole('region', { name: 'Person hinzufügen' });
  await expect(reinvite).toBeVisible();
  await reinvite.getByRole('button', { name: 'OIDC-Konto (SSO)' }).click();
  await reinvite.getByLabel('Name', { exact: true }).fill(SSO_NAME);
  await reinvite.getByLabel('E-Mail-Adresse', { exact: true }).fill(SSO_EMAIL);
  await reinvite
    .getByLabel('Rolle', { exact: true })
    .selectOption({ label: SSO_GROUP });
  await reinvite.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(
    admin.getByRole('listitem').filter({ hasText: SSO_EMAIL }),
    'Dieselbe Adresse ist wieder frei — hätte die `user`-Zeile das Entfernen ' +
      'überlebt, hinge hier das bestehende OIDC-Konto und die Zeile läse „OIDC".',
  ).toContainText('Eingeladen');

  // And the account that has just come into being goes back out the same way.
  await removeSsoPerson();

  /*
   * --- absent *and* locked, and at the same time the clean-up -------------
   *
   * An organization that goes on offering a button would be residue with a
   * face: every later `auth-flow.spec.ts` would meet it on the login page.
   * Switching it off is therefore both — clean-up and the second half of the
   * evidence.
   */
  await admin.goto(TENANT_APPEARANCE_PATH);
  const card = admin.getByRole('region', { name: 'Anmeldung (OIDC / SSO)' });
  await card
    .getByRole('switch', { name: 'SSO-Anmeldung anbieten', exact: true })
    .click();
  await save(card);

  const afterContext = await browser.newContext();
  const afterOff = await afterContext.newPage();
  try {
    await afterOff.goto('/');
    await expectLoginView(afterOff);
    await expect(afterOff.getByRole('link', { name: SSO_BUTTON })).toHaveCount(
      0,
    );
  } finally {
    await afterContext.close();
  }
});
