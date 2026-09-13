import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

import {
  addQuestion,
  expectNoHorizontalScroll,
  openMobileMenu,
  publishAndReadPath,
  saveForm,
  expectSaved,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * **The full run: this section's new paths on a
 * real form.**
 *
 * The rules are the same as before: **without SQL, without
 * a seed trick, without a manual reach into the JSONB**. Building, configuring and
 * checking happen exclusively through the interface; the database is **read**
 * (through the application's own routes, under the signed-in session) in order
 * to prove — and **never written** to establish a state.
 *
 * ## The one named deviation: the AI step runs against a recording
 *
 * Step 1 demands "designing a form **with the AI**". This environment
 * has **no** provider key (`AI_PROVIDER` is empty, the session reports
 * `aiFormsAvailable: false`, and `GET /api/ai/quota` answers 404 —
 * `ai-feature.guard.ts`). A real call would on top of that be money and a
 * dependency on a foreign service on **every** run.
 *
 * That is why exactly **one** answer is recorded — `POST /api/ai/forms` —,
 * and that following the pattern `mobile-paths.spec.ts` has already written
 * down for the same dialog: the payload is **not written by hand**,
 * but derived from a **real** answer of the server
 * ({@link recordAiAnswer}). That is the lesson from `mail-log-mobile.spec.ts`,
 * whose hand-written mock failed silently for four runs because the schema
 * gained a field; `e2e/` deliberately keeps `@formsache/shared` out
 * (`api-dev.spec.ts` says why), so nothing here can be parsed against a Zod
 * schema — a **derived** payload, in contrast, is schema-valid by construction,
 * because the server produced it.
 *
 * ⚠️ **What is recorded is the model's answer, not the adopting.**
 * *Adopting* goes through `useAdoptAiForm` and thereby through the **real**
 * routes `POST /forms` and `PUT /forms/:id`; the form that stands in the
 * builder afterwards is a real form in the database. Everything after the
 * preview — adopting, reworking, publishing, filling in, evaluating,
 * exporting — runs without any mock whatsoever.
 *
 * ## What does *not* work at this level, and what is proven instead
 *
 * Step 3 demands continuing the draft "**the next day**". The clock the
 * deadlines from 0.3 hang on (30 days for a draft, 24 hours for a *removed*
 * attachment) is the **injected clock of the server**
 * (`MailClock`/`MutableClock`) — and the server runs here as its own process
 * (`pnpm --filter @formsache/api dev`, see `playwright.config.ts`), into which
 * no test double reaches. At the e2e level only the **browser clock** is
 * therefore movable, and it decides none of these deadlines.
 *
 * What this run proves is therefore expressly the weaker thing, and it is named
 * as such: the draft is continued in a **different browser context** and with a
 * browser clock advanced by one day, and the attachment is still there. The
 * **deadlines** themselves are measured with the movable clock in
 * `apps/api/test/public/draft.spec.ts` and
 * `apps/api/test/public/draft-attachment.spec.ts`; there is no second, weaker
 * proof of them here.
 *
 * ## Leaving no residue is a precondition, not politeness
 *
 * This run creates **no organisation of its own**: it works in the organisation
 * of the parked session and marks **everything** it creates with {@link STAMP}.
 * Counting goes by that mark and **not** by the tenant id — the reason
 * stands in `apps/api/test/load/anmeldestart.ts`: a count by one's own
 * tenant id is blind by construction for a **surviving** organisation
 * (and after its deletion 0 anyway), so in principle it cannot see the residue
 * of an aborted run.
 *
 * {@link measureResidue} reads **one** object and {@link test.afterAll}
 * compares it as a whole, so that a failure names **everything** that is left
 * over, and not just the first thing. No cleanup step ends silently: there is
 * no `catch {}` and no `count()` exit — whoever gets here has built, so
 * something **must** be there, and if it is not, a loud failure is the
 * right answer. That is literally the finding where the silent
 * `count()` in `trashForm` left two `response` rows with names, addresses and
 * participant addresses standing after a **green** run.
 *
 * ## Why an own project that depends on all the others
 *
 * Like `durchlauf-organisationen` and `durchlauf-funktionsumfang`: the run
 * pages through the **shared** form list of the organisation (step 8) and needs
 * a list that nobody re-sorts on it while it pages. It therefore runs last and
 * alone; Playwright has no "exclusive", it has project dependencies. See
 * `playwright.config.ts`.
 */

test.describe.configure({ mode: 'serial' });

/* --- the mark of this run ------------------------------------------------ */

/**
 * **The mark** by which this run finds again everything it has created —
 * and by which the residue measurement counts. A timestamp in base 36,
 * upper-cased, so that it is recognizable as such in a form title.
 */
const STAMP = `M5G1${Date.now().toString(36).toUpperCase().slice(-5)}`;

const FORM_TITLE = `Jahrestreffen ${STAMP}`;
/**
 * The form the recorded AI answer takes its definition from.
 * It is built through the builder, read and cleared away again with
 * everything else — see {@link recordAiAnswer}.
 */
const SOURCE_TITLE = `KI-Aufzeichnung ${STAMP}`;
/** The filler forms from step 8, so that the list has two pages. */
const FILLER_PREFIX = `Fuellformular ${STAMP}`;

/* --- the questions of the form, in one place ----------------------------- */

const Q = {
  name: 'Name des Teilnehmers',
  mail: 'E-Mail des Teilnehmers',
  choice: 'Verpflegungswunsch',
  address: 'Anschrift',
  note: 'Anmerkung',
  table: 'Speiseplan je Tag',
  events: 'Veranstaltungen',
  file: 'Nachweis',
} as const;

const CHOICE_MEAT = 'Mit Fleisch';
const CHOICE_VEGGIE = 'Vegetarisch';

const EVENT_GALA = 'Galaabend';
const EVENT_PARTY = 'Sommerfest';

/** Start rows and upper limit of the table question. */
const TABLE_ROWS = 2;
const TABLE_MAX_ROWS = 6;

/** Every address of this run is unroutable by construction (RFC 2606). */
const PARTICIPANT_1 = `m5g1-1-${STAMP.toLowerCase()}@example.invalid`;
const PARTICIPANT_2 = `m5g1-2-${STAMP.toLowerCase()}@example.invalid`;
const PARTICIPANT_3 = `m5g1-3-${STAMP.toLowerCase()}@example.invalid`;
/** The reply-to address of the notification — step 7 reads it twice. */
const REPLY_TO = `sekretariat-${STAMP.toLowerCase()}@example.invalid`;

/**
 * The postal code with its leading zero and the free text
 * that a spreadsheet program would take for a formula. Both stand
 * here because step 3 enters them and step 6 finds them again in three files.
 */
const ZIP = '01067';
const FORMULA_TEXT = '=SUM(A1)';

/**
 * **The test piece for assumption A7 of ADR-0014 no. 5** — the signature check
 * demands `%PDF-` at **offset 0**, no whitespace, no BOM. The byte prefix is
 * the one measured in `durchlauf-funktionsumfang.spec.ts` (`%PDF-1.7\n` plus binary marker);
 * everything behind it is made up. What is checked is the prefix, not the text.
 */
const SCANNER_PDF = Buffer.concat([
  Buffer.from([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xf6, 0xe4,
    0xfc, 0xdf, 0x0a,
  ]),
  Buffer.from(
    '1 0 obj\n<< /Type /Catalog >>\nendobj\n' +
      '% erfundener Inhalt, kein Geraetematerial\n' +
      'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
    'latin1',
  ),
]);
const SCANNER_PDF_NAME = 'Scan Bescheinigung.pdf';

/* --- state that the steps hand on to one another ------------------------- */

interface BuiltForm {
  id: string;
  path: string;
  title: string;
}

let adminContext: BrowserContext;
/** The superadmin, on the session that `auth.setup.ts` parked. */
let admin: Page;

let form: BuiltForm = { id: '', path: '', title: FORM_TITLE };
/** The template of the recorded answer — a real form. */
let sourceFormId = '';
/** The filler forms from step 8, with their titles for finding them again. */
const fillerTitles: string[] = [];

/** The token of the draft from step 3 — step 3 mints it. */
let draftToken = '';
/** The attachment's address — the residue measurement queries it at the end. */
let attachmentPath = '';

/**
 * The numbers **before** the run. `-1` is not a plausible number and can
 * therefore not be mistaken for a measurement.
 */
const before = { tenants: -1, members: -1, aiQuotaStatus: -1 };

/* --- small helpers ------------------------------------------------------- */

/** Reads a field from foreign JSON without forcing a shape upon it. */
function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The one save bar of a page or card; waits until it has **landed**.
 * Wording and reasoning as in `durchlauf-funktionsumfang.spec.ts`: every save bar
 * disables its button with `isPending || !dirty`, a click on a
 * clean draft would otherwise wait until the test's deadline.
 */
async function save(scope: Locator | Page): Promise<void> {
  const button = scope.getByRole('button', { name: 'Speichern', exact: true });
  await expect(
    button,
    'Der Speichern-Knopf ist `isPending || !dirty` — steht er still, gibt es ' +
      'nichts zu speichern, und der Klick wartete sonst bis zur Testfrist.',
  ).toBeEnabled();
  await button.click();
  await expectSaved(scope);
}

/** The id from a builder address — `/forms/<id>`. */
function formIdOf(url: string): string {
  const id = new URL(url).pathname.split('/')[2];
  expect(id, `[m5g1] keine Builder-Adresse: ${url}`).toBeTruthy();
  return id ?? '';
}

/** The *Pflichtfeld* checkbox in the properties panel — via the role. */
function requiredCheckbox(page: Page): Locator {
  return page.getByRole('checkbox', { name: 'Pflichtfeld', exact: true });
}

/** A JSON answer of our own API, under the signed-in session. */
async function readJson(page: Page, path: string): Promise<unknown> {
  const answer = await page.request.get(path);
  expect(answer.status(), `[m5g1] ${path} muss lesbar sein`).toBe(200);
  return answer.json();
}

/** Opens the form's responses view through the card in the dashboard. */
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

/* --- CSV, read the way a spreadsheet would ------------------------------- */

/** Splits a CSV line into fields, RFC-4180 quoting respected (`csv.ts`). */
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

/* --- Excel, really opened ------------------------------------------------ */

/**
 * **An `.xlsx` is a ZIP archive, and this reader really opens it.**
 *
 * Why by hand and not with `exceljs`: `e2e/` does not have the dependency and
 * shall not get it (the same boundary that keeps `@formsache/shared` out of
 * `e2e/`). What is needed here is narrower than a
 * workbook library anyway — namely **the bytes**: which cells there are,
 * which type they carry in the file, and whether an `<f>` stands anywhere.
 * `packages/shared/src/export-xlsx.test.ts` measures the cell types deeply and with
 * `exceljs`; this run measures that the **downloaded** file says the
 * same.
 *
 * Supported are the two methods every writer uses:
 * `0` (uncompressed) and `8` (deflate). Everything else throws — a silent
 * return would be a file this test would take for empty.
 *
 * ⚠️ **What is read is the central directory, not the chain of local headers** —
 * and that is no subtlety but the first finding of this step.
 * `ExcelJS` writes **streaming**: in the local header of each entry
 * size and checksum stand at `0`, the real numbers only come afterwards in the
 * data descriptor. A reader running through from the front therefore does not
 * know after the first entry where the next one begins. Measured on 2026-08-10
 * on the real download file: `_rels/` with size 0. The central directory at the
 * end carries both sizes for every entry **and** the offset of its local
 * header; from there every file is reachable individually.
 */
function readZipEntries(archive: Buffer): Map<string, Buffer> {
  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;

  // The end directory stands at the back and carries a comment of variable
  // length, so it is searched backwards — 22 bytes is its minimum size.
  let eocd = -1;
  for (let index = archive.length - 22; index >= 0; index -= 1) {
    if (archive.readUInt32LE(index) === EOCD) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('[m5g1] kein ZIP-Archiv: kein Ende-Verzeichnis gefunden');
  }

  const entries = new Map<string, Buffer>();
  const count = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);

  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== CENTRAL) {
      throw new Error(
        `[m5g1] beschädigtes Zentralverzeichnis bei Eintrag ${String(index)}`,
      );
    }
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString(
      'utf8',
      cursor + 46,
      cursor + 46 + nameLength,
    );

    // The local header's extra fields may have a **different** length than the
    // ones in the directory; the data start is therefore read where it applies.
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = archive.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) {
      entries.set(name, Buffer.from(data));
    } else if (method === 8) {
      entries.set(name, inflateRawSync(data));
    } else {
      throw new Error(
        `[m5g1] unbekanntes ZIP-Verfahren ${String(method)} für ${name}`,
      );
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

interface Workbook {
  /** The header row of the sheet — the only row without empty cells. */
  readonly header: readonly string[];
  /** **Every** cell value of the file, flat — strings as well as numbers. */
  readonly values: readonly string[];
  /** How many `<row>` elements the sheet carries. */
  readonly rowCount: number;
  /** Whether any cell carries a **formula** (`<f>` in the sheet). */
  readonly hasFormula: boolean;
  /** How many cells stand as a **number** in the file (no `t` attribute). */
  readonly numericCells: number;
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll(/&#(\d+);/gu, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replaceAll('&amp;', '&');
}

interface SheetCell {
  readonly value: string;
  readonly numeric: boolean;
}

/**
 * A cell of the sheet, just as it stands in the file.
 *
 * Three forms, and the distinction is the point of the requirement:
 * `t="s"` points into the `sharedStrings` pool, `t="inlineStr"` carries the
 * text with it (**that** is what `ExcelJS` writes without `useSharedStrings`), and a
 * cell **without** `t` with a `<v>` is a number.
 */
function readCell(
  attributes: string,
  body: string,
  strings: readonly string[],
): SheetCell {
  const type = /t="([a-zA-Z]+)"/u.exec(attributes)?.[1];
  const raw = /<v>([\s\S]*?)<\/v>/u.exec(body)?.[1];
  if (type === 's') {
    return { value: strings[Number(raw ?? '0')] ?? '', numeric: false };
  }
  if (raw !== undefined) {
    return { value: decodeXmlText(raw), numeric: type === undefined };
  }
  const inline = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/gu)]
    .map((part) => decodeXmlText(part[1] ?? ''))
    .join('');
  return { value: inline, numeric: false };
}

/**
 * Reads the first worksheet of a downloaded `.xlsx`.
 *
 * **The header row position-exact, the rest as a set** — and that is a
 * decision, not convenience: an empty cell stands in OOXML as
 * `<c r="G3"/>` or not at all, a data row is therefore **not** to be read
 * position-exact without evaluating the `r` references. What this run has to
 * check on the Excel file does not need that either: the column order it
 * measures on the **CSV** (cell by cell, with header mapping), and from Excel it
 * wants to know whether the same header row stands above it and what the file
 * made out of `=SUM(A1)` and `01067`.
 */
function readWorkbook(archive: Buffer): Workbook {
  const entries = readZipEntries(archive);
  const sheet = entries.get('xl/worksheets/sheet1.xml');
  expect(
    sheet,
    'Die Excel-Datei muss ein erstes Arbeitsblatt enthalten — sonst ist ' +
      'heruntergeladen worden, was kein Arbeitsbuch ist.',
  ).toBeDefined();
  const sheetXml = (sheet ?? Buffer.alloc(0)).toString('utf8');

  const stringsXml = (
    entries.get('xl/sharedStrings.xml') ?? Buffer.alloc(0)
  ).toString('utf8');
  const strings = [...stringsXml.matchAll(/<si>([\s\S]*?)<\/si>/gu)].map(
    (match) =>
      [...(match[1] ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/gu)]
        .map((part) => decodeXmlText(part[1] ?? ''))
        .join(''),
  );

  const rows = [...sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/gu)].map(
    (rowMatch) =>
      [...(rowMatch[1] ?? '').matchAll(/<c\s([^>]*?)>([\s\S]*?)<\/c>/gu)].map(
        (cellMatch) =>
          readCell(cellMatch[1] ?? '', cellMatch[2] ?? '', strings),
      ),
  );

  const cells = rows.flat();
  return {
    header: (rows[0] ?? []).map((cell) => cell.value),
    values: cells.map((cell) => cell.value),
    rowCount: rows.length,
    hasFormula: /<f[\s>]/u.test(sheetXml),
    numericCells: cells.filter((cell) => cell.numeric).length,
  };
}

/* --- the recording of the AI answer -------------------------------------- */

interface AiRecording {
  readonly session: Record<string, unknown>;
  readonly definition: unknown;
  readonly title: string;
}

/**
 * **The recorded answer**, derived instead of invented.
 *
 * A real small form is built through the builder; its
 * **definition** — produced by the server and thereby schema-valid by construction —
 * becomes the `definition` of the recorded answer to `POST /api/ai/forms`.
 * Plus the real session from `GET /api/auth/me`, in which **one** field
 * is rewritten (`aiFormsAvailable`), so that the menu entry is there at
 * all.
 *
 * The source form stays standing and is cleared away with everything else: it
 * carries {@link STAMP} and therefore stands in the same measurement as the rest.
 */
async function recordAiAnswer(page: Page): Promise<AiRecording> {
  await newFormNamed(page, SOURCE_TITLE);
  sourceFormId = formIdOf(page.url());

  await addQuestion(page, 'Text', Q.name);
  await requiredCheckbox(page).check();
  await addQuestion(page, 'E-Mail', Q.mail);
  await requiredCheckbox(page).check();
  await addQuestion(page, 'Einfachauswahl', Q.choice);
  await page.getByRole('textbox', { name: 'Option 1' }).fill(CHOICE_MEAT);
  await page.getByRole('textbox', { name: 'Option 2' }).fill(CHOICE_VEGGIE);
  await requiredCheckbox(page).check();
  await saveForm(page);

  const detail = await readJson(page, `/api/forms/${sourceFormId}`);
  const definition = property(detail, 'definition');
  expect(
    definition,
    'Ohne die Definition des Quellformulars gäbe es nichts aufzuzeichnen — ' +
      'und eine handgeschriebene Nutzlast ist genau die Attrappe, die diese ' +
      'Datei nicht baut.',
  ).toBeDefined();

  const session = (await readJson(page, '/api/auth/me')) as Record<
    string,
    unknown
  >;
  return { session, definition, title: 'Anmeldung zum Jahrestreffen' };
}

/**
 * `newForm` with a **fixed** title.
 *
 * `app-flows.newForm` appends a timestamp itself; this run needs
 * titles that it later finds again exactly through the search, and its
 * uniqueness comes from {@link STAMP}.
 */
async function newFormNamed(page: Page, title: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Name des neuen Formulars').fill(title);
  await page.getByRole('button', { name: '+ Neues Formular' }).click();
  await expect(page.getByLabel('Formularname')).toHaveValue(title);
  await expect(page).toHaveURL(/\/forms\//u);
}

/* --- setup --------------------------------------------------------------- */

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext({ storageState: authStateFile });
  admin = await adminContext.newPage();

  before.tenants = Number(
    property(
      property(await readJson(admin, '/api/admin/tenants'), 'totals'),
      'tenants',
    ),
  );
  before.members = asArray(
    property(await readJson(admin, '/api/tenant/users'), 'members'),
  ).length;
  before.aiQuotaStatus = (await admin.request.get('/api/ai/quota')).status();
});

/* --- cleanup and residue measurement ------------------------------------- */

/** All titles of this run — the mark by which cleaning up and counting happen. */
function markedTitles(): readonly string[] {
  return [FORM_TITLE, SOURCE_TITLE, ...fillerTitles];
}

/**
 * Puts **every** marked form into the trash through „× Löschen" in the
 * dashboard.
 *
 * Through the interface and not through `DELETE /api/forms/:id`: the cleanup is
 * itself a proof, and a cleanup through a different path than the one
 * a person takes proves nothing for exactly that path.
 *
 * **Without a silent exit.** Here stood once `if ((await
 * card.count()) === 0) return;` — `count()` waits for nothing, the dashboard
 * draws no `<article>` until `forms.isPending`, the handle read zero hits,
 * turned around, threw nothing, and the run reported green with two responses
 * including names and addresses in the database. What is waited for is
 * therefore the **list**, and the number before it is asserted.
 */
async function trashMarkedForms(): Promise<void> {
  const expected = markedTitles().length;
  /*
   * **Counting happens at the route, not at the cards.** In step 8 the run
   * creates more forms than fit on **one** page — the cards
   * of one page are therefore `min(hits, page size)` and are no measure for
   * "everything cleared away". The `total` of the search is one, and it is the
   * same number the residue measurement reads at the end.
   */
  expect(
    await markedFormCount(),
    `Die Marke „${STAMP}" muss ${String(expected)} Formulare finden — steht ` +
      'hier eine andere Zahl, räumt dieses Aufräumen nicht das ab, was der ' +
      'Lauf gebaut hat.',
  ).toBe(expected);

  await admin.goto('/');
  /*
   * **First visible, then typed** — the rule that `save()` writes down further
   * above for the save button, here for a second reason: `fill`
   * waits for **operability**, and this waiting time is bound to the deadline of
   * the *test*, not to the short deadline of an assertion. Measured on
   * 2026-08-10: a search field that (as `type="search"`) carries the role
   * `searchbox` and not `textbox` made exactly this `fill` wait **300 s** and
   * thereby took the whole cleanup hook including the residue measurement with
   * it. The assertion before it turns that into a readable failure after seconds.
   */
  const search = admin.getByRole('searchbox', {
    name: 'Formulare durchsuchen',
  });
  await expect(search).toBeVisible();
  await search.fill(STAMP);

  for (let done = 0; done < expected; done += 1) {
    const card = admin.getByRole('article').first();
    await expect(
      card,
      'Die Suche muss noch eine Karte dieses Laufs zeigen — sonst legt ' +
        'dieses Aufräumen nichts mehr in den Papierkorb, obwohl die Route ' +
        'noch Formulare kennt.',
    ).toBeVisible();
    await card.getByRole('button', { name: 'Löschen' }).click();
    await card.getByRole('button', { name: 'In den Papierkorb legen' }).click();
    await expect
      .poll(markedFormCount, {
        message:
          'Nach jedem „In den Papierkorb legen" muss die Marke ein Formular ' +
          'weniger finden.',
      })
      .toBe(expected - done - 1);
  }
}

/**
 * Deletes the marked entries in the trash **permanently** — row by row.
 *
 * Expressly **not** „Papierkorb leeren": the trash belongs to the whole
 * organisation, and this run shares it with every other spec (the reasoning stands
 * at `trash-purge.spec.ts` as well). What is permanently deleted is exactly
 * what carries this mark — and that is at the same time the step that
 * physically takes the attachment in storage and the person out of the `mail_log` with it.
 */
async function purgeMarkedTrash(): Promise<void> {
  await admin.goto('/admin/trash');
  await expect(
    admin.getByRole('heading', { name: 'Papierkorb', level: 1 }),
  ).toBeVisible();

  const marked = admin
    .locator('[data-testid="trash-deleted-form"]')
    .filter({ hasText: STAMP });
  await expect(
    marked,
    'Vor dem endgültigen Löschen müssen die Formulare dieses Laufs im ' +
      'Papierkorb liegen — sonst sagt „danach nichts mehr da" nichts aus.',
  ).toHaveCount(markedTitles().length);

  for (let guard = 0; guard < markedTitles().length + 2; guard += 1) {
    const remaining = await marked.count();
    if (remaining === 0) {
      break;
    }
    const row = marked.first();
    await row.getByTestId('trash-purge-form').click();
    /*
     * **The confirmation, not the trigger.** Both are called „Endgültig löschen" —
     * the button of the row and the confirming one below it (`TrashView.tsx`,
     * `confirmLabel`). A name alone therefore hits two elements here
     * (measured on 2026-08-10: `strict mode violation … resolved to 2
     * elements`, and the cleanup stopped at this row — with two
     * forms and two `mail_log` rows including a person in the database).
     * `ConfirmPrompt` carries `role="alert"`, and that is the difference that
     * exists without resorting to a CSS class.
     */
    await row
      .getByRole('alert')
      .getByRole('button', { name: 'Endgültig löschen', exact: true })
      .click();
    await expect(marked).toHaveCount(remaining - 1);
  }
  await expect(marked).toHaveCount(0);

  await expect(
    admin
      .locator('[data-testid="trash-deleted-response"]')
      .filter({ hasText: STAMP }),
    'Die Antworten dieses Laufs gehen mit ihren Formularen — bleibt hier ' +
      'eine stehen, liegen personenbezogene Daten im Papierkorb.',
  ).toHaveCount(0);
}

/**
 * What this run **still carries** at the end — per place that it really touches,
 * read through the application's own routes.
 *
 * **One** object that is compared as a whole:
 * a failure thereby names everything that is left over, and not just the first thing.
 * Seven numbers and three status codes; every single one is a measurement and not
 * an assumption.
 */
interface Residue {
  /** Forms with the mark — `total`, not `items.length`. */
  readonly forms: number;
  readonly trashedForms: number;
  readonly trashedResponses: number;
  readonly templates: number;
  /**
   * `mail_log` rows that **still carry a person**. The rows themselves
   * stay standing on purpose (operational proof) — what has to go is
   * recipient, subject and body.
   */
  readonly mailLinesWithPerson: number;
  /** The attachment from step 3, queried through its address. 404 = gone. */
  readonly attachmentStatus: number;
  /** The draft from step 3, queried through its token. 404 = gone. */
  readonly draftStatus: number;
  /** Accounts in the organisation — absolute, compared with the number **before** the run. */
  readonly members: number;
  /** Living organisations — absolute, compared with the number before the run. */
  readonly tenants: number;
  /**
   * `GET /api/ai/quota`. This environment has no key, the route
   * answers 404 — before **and** after the run. The number is the proof that the
   * recorded answer has not cost a call: had anything taken the
   * real path, a different status would stand here.
   */
  readonly aiQuotaStatus: number;
}

/**
 * Whether a field carries the mark of this run — **regardless of upper and
 * lower case**.
 *
 * That is no convenience: the titles carry the mark in upper case, the addresses
 * in lower case (`m5g1…@example.invalid`), and a check that knows only the one
 * spelling would never have seen the **recipient** of a `mail_log` row — that
 * is, of all things, the column that the residue of personal data is
 * about.
 */
function carriesStamp(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.toLowerCase().includes(STAMP.toLowerCase())
  );
}

/**
 * How many forms of the organisation carry the mark — through **the same** search
 * that the dashboard uses.
 *
 * ⚠️ **The parameter is called `q`, not `search`** — found in the full
 * `pnpm e2e` on 2026-08-10, and only there: `formListQuerySchema` is an
 * ordinary `z.object`, so it **silently discards** unknown keys. A
 * `?search=…` is thereby not rejected but **ignored**, and the route
 * answers with the first page of the whole organisation. Against a fresh
 * database that looked right (after the cleanup both are 0); in the full
 * run, with the residue of the rest of the suite in the same organisation, there stood
 * **`Expected: 2, Received: 97`**.
 *
 * That is exactly the sort of false green this measurement is built against —
 * it caught itself here, because the number is **asserted** and not
 * read.
 */
async function markedFormCount(): Promise<number> {
  return Number(
    property(
      await readJson(admin, `/api/forms?q=${encodeURIComponent(STAMP)}`),
      'total',
    ),
  );
}

async function measureResidue(): Promise<Residue> {
  const trash = await readJson(admin, '/api/trash');
  /*
   * **Without a page parameter, and that is no negligence:** the route takes
   * `status` and `formId`, nothing else, and delivers the **newest 200**
   * rows (`ScopedMailLogDelegate.findMany`). This run is the last
   * project of the suite, so its rows are the youngest — they lie in
   * this page. Filtering by `formId` is precisely **not** possible here: the
   * permanent deletion sets `mail_log.form_id` to `NULL`, and it is exactly
   * afterwards that the measurement is taken.
   */
  const mailLog = await readJson(admin, '/api/mail-log');
  const templates = await readJson(admin, '/api/form-templates');

  return {
    forms: await markedFormCount(),
    trashedForms: asArray(property(trash, 'forms')).filter((entry) =>
      carriesStamp(property(entry, 'title')),
    ).length,
    trashedResponses: asArray(property(trash, 'responses')).filter((entry) =>
      carriesStamp(property(entry, 'formTitle')),
    ).length,
    templates: asArray(property(templates, 'templates')).filter((entry) =>
      carriesStamp(property(entry, 'name')),
    ).length,
    /*
     * **`recipient` and `subject`, expressly not `reply_to`.** The
     * reply-to address stays standing through the permanent deletion, and that is a
     * reasoned decision, not a gap (written out in
     * `apps/api/src/mail-log/mail-log-erasure.ts`): it cannot stem from a
     * response — there is no placeholder and no renderer for it
     * —, it comes from settings that an editor types, and names
     * an office instead of a participant. To count it in here would mean
     * slipping this run a promise that nobody has given.
     */
    mailLinesWithPerson: asArray(property(mailLog, 'entries')).filter(
      (entry) =>
        carriesStamp(property(entry, 'recipient')) ||
        carriesStamp(property(entry, 'subject')),
    ).length,
    attachmentStatus:
      attachmentPath === ''
        ? 404
        : (await admin.request.get(attachmentPath)).status(),
    draftStatus:
      draftToken === ''
        ? 404
        : (
            await admin.request.get(`/api/public/drafts/${draftToken}`)
          ).status(),
    members: asArray(
      property(await readJson(admin, '/api/tenant/users'), 'members'),
    ).length,
    tenants: Number(
      property(
        property(await readJson(admin, '/api/admin/tenants'), 'totals'),
        'tenants',
      ),
    ),
    aiQuotaStatus: (await admin.request.get('/api/ai/quota')).status(),
  };
}

test.afterAll(async () => {
  /*
   * Not the 30 s of the default: this hook runs a dozen navigations and
   * as many delete confirmations as the run has created forms — through
   * the real application.
   */
  test.setTimeout(300_000);

  /*
   * **What this run has built, it clears away — what it never built, it does not
   * look for.** `sourceFormId === ''` means: step 1 did not get as far as the first
   * form; the phases would then have run against locator deadlines that prove nothing.
   */
  const builtSomething = sourceFormId !== '';

  /** Filled by the measuring phase, checked after the loop. */
  let residue: Residue | undefined;

  const phases: readonly (readonly [string, () => Promise<void>])[] =
    builtSomething
      ? ([
          ['die Formulare in den Papierkorb zu legen', trashMarkedForms],
          ['den Papierkorb dieses Laufs zu leeren', purgeMarkedTrash],
          [
            'den Rückstand zu messen',
            async () => {
              residue = await measureResidue();
            },
          ],
        ] as const)
      : [];

  for (const [what, run] of phases) {
    const started = Date.now();
    try {
      await run();
    } catch (error) {
      console.error(
        `[m5g1] Aufräumen: ${what} ist nach ${String(Date.now() - started)} ms gescheitert:`,
        error,
      );
    }
  }

  try {
    /*
     * **The assertion, not merely a log line** : an
     * `afterAll` that only reports a deviation is the "it looks cleaned
     * up" that this cleanup is built against. **One** object is compared
     * and not ten single numbers, so that the failure names everything.
     */
    if (builtSomething) {
      expect(
        residue,
        'der Rückstand dieses Laufs muss gemessen worden sein — ohne ' +
          'Messung ist „nichts übrig" eine Behauptung.',
      ).toEqual({
        forms: 0,
        trashedForms: 0,
        trashedResponses: 0,
        templates: 0,
        mailLinesWithPerson: 0,
        attachmentStatus: 404,
        draftStatus: 404,
        members: before.members,
        tenants: before.tenants,
        aiQuotaStatus: before.aiQuotaStatus,
      });
    }
  } finally {
    /*
     * One `try` per handle, for the reason that `durchlauf-organisationen` has written down:
     * a `beforeAll` that threw early leaves holders unassigned, and a
     * throwing `close()` must not take the others with it.
     */
    try {
      await adminContext.close();
    } catch (error) {
      console.error(
        '[m5g1] Aufräumen: den Superadmin-Kontext zu schließen scheiterte:',
        error,
      );
    }
  }
});

/* --- step 1 -------------------------------------------------------------- */

test('Schritt 1 — ein Formular mit der KI entwerfen, die Vorschau ansehen, übernehmen und im Builder nacharbeiten', async () => {
  test.setTimeout(420_000);

  // --- the recording, derived from a real answer ----------------------------
  const recording = await recordAiAnswer(admin);

  /*
   * **Without a key the feature does not exist**  —
   * and that is the state of this environment. Measured before the mock
   * establishes the other situation: otherwise it could not be said later
   * whether the menu entry was there because the application shows it, or
   * because it always stands there anyway.
   */
  expect(
    property(recording.session, 'aiFormsAvailable'),
    'Diese Umgebung hat keinen KI-Schlüssel — der Schritt darunter stellt die ' +
      'andere Lage her, indem er genau dieses Feld umschreibt.',
  ).toBe(false);
  expect(
    before.aiQuotaStatus,
    'Ohne Schlüssel antwortet `GET /api/ai/quota` 404 (`ai-feature.guard.ts`).',
  ).toBe(404);

  await admin.goto('/');
  /*
    **On the dashboard, next to „+ Neues Formular"** (finding 18) — until then
    „✦ KI-Formular" stood as the last entry of the head navigation.

    The positive control stands before it, and it is not decoration: the
    create box hangs on `canBuild` and on an organisation, and without it
    "no AI button" would also be true for a page that does not draw this box
    at all.
  */
  const createBox = admin.locator('.dashboard__create');
  await expect(
    createBox.getByRole('button', { name: '+ Neues Formular' }),
  ).toBeVisible();
  await expect(
    admin.getByRole('button', { name: /KI-Formular/u }),
    'Der Knopf ist **abwesend**, nicht ausgegraut — ein ausgegrauter ' +
      'verspräche eine Funktion, die es nicht gibt (der Nachweis). Gemessen ' +
      'auf der ganzen Seite und nicht nur im Kasten: auch die Kopfzeile darf ' +
      'ihn nicht mehr tragen.',
  ).toHaveCount(0);

  // --- hang in the recorded answer ------------------------------------------
  await admin.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...recording.session, aiFormsAvailable: true }),
    });
  });
  await admin.route('**/api/ai/quota', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ used: 2, limit: 50 }),
    });
  });
  await admin.route('**/api/ai/forms', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        title: recording.title,
        definition: recording.definition,
        quota: { used: 3, limit: 50 },
      }),
    });
  });

  await admin.goto('/');
  /*
    And with a key it stands **in the create box** — not somewhere on the
    page. "It is visible" would be green even if it came back in the head
    bar, and that is exactly the place it comes from.
  */
  const entry = admin
    .locator('.dashboard__create')
    .getByRole('button', { name: /KI-Formular/u });
  await expect(
    admin.getByRole('button', { name: /KI-Formular/u }),
    'Genau einer — ein zweiter in der Kopfzeile wäre der Weg, der aufgegeben ' +
      'wurde.',
  ).toHaveCount(1);
  await expect(
    entry,
    'Mit Schlüssel steht „✦ KI-Formular" auf dem **Dashboard**, neben ' +
      '„+ Neues Formular" (Befund 18). In der Kopfzeile stand es bis dahin — ' +
      'als einziger Eintrag dort, der keine Adresse war, sondern einen Dialog ' +
      'aufmachte. Was er tut, ist ein Formular anlegen; das gehört neben den ' +
      'Knopf, der dasselbe tut.',
  ).toBeVisible();
  await entry.click();

  // --- dialog, preview, adopt -----------------------------------------------
  const dialog = admin.getByRole('dialog', {
    name: 'Formular mit KI erstellen',
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel('Beschreibung des Formulars')
    .fill(
      'Eine Anmeldung zum Jahrestreffen mit Name, E-Mail-Adresse und ' +
        'Verpflegungswunsch.',
    );
  await dialog.getByRole('button', { name: /Formular generieren/u }).click();

  await expect(
    dialog,
    'Die Vorschau kommt **vor** der Übernahme: bis hierher ist ' +
      'nichts angelegt.',
  ).toContainText('Vorschau – noch ist nichts angelegt');
  await expect(dialog.getByLabel('Name des neuen Formulars')).toHaveValue(
    recording.title,
  );
  for (const label of [Q.name, Q.mail, Q.choice]) {
    await expect(
      dialog,
      `Die Vorschau muss zeigen, was die Antwort trug — „${label}".`,
    ).toContainText(label);
  }
  await expect(dialog).toContainText(
    'KI-Kontingent dieser Organisation: 3 von 50 Aufrufen verbraucht, 47 übrig.',
  );

  const formsBefore = Number(
    property(await readJson(admin, '/api/forms'), 'total'),
  );

  await dialog.getByLabel('Name des neuen Formulars').fill(FORM_TITLE);
  await dialog.getByRole('button', { name: 'Übernehmen', exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect(admin.getByLabel('Formularname')).toHaveValue(FORM_TITLE);
  form = { id: formIdOf(admin.url()), path: '', title: FORM_TITLE };
  expect(
    form.id,
    'Die KI legt ein **neues** Formular an und überschreibt keinen offenen ' +
      'Entwurf.',
  ).not.toBe(sourceFormId);

  // The mock only delivered the *answer of the model*; the form really came
  // into being through `POST /forms` and `PUT /forms/:id`.
  await admin.unroute('**/api/ai/forms');
  await admin.unroute('**/api/ai/quota');
  await admin.unroute('**/api/auth/me');
  expect(
    Number(property(await readJson(admin, '/api/forms'), 'total')),
    'Genau ein Formular ist hinzugekommen — die Übernahme geht durch die ' +
      'echten Routen, nicht durch die Aufzeichnung.',
  ).toBe(formsBefore + 1);

  // --- rework: the AI delivers a draft, not a completion --------------------
  await admin.goto(`/forms/${form.id}`);
  await expect(admin.getByLabel('Formularname')).toHaveValue(FORM_TITLE);

  await addQuestion(admin, 'Adresse', Q.address);
  await addQuestion(admin, 'Text', Q.note);
  await addQuestion(admin, 'Datei-Upload', Q.file);

  await addQuestion(admin, 'Veranstaltung', Q.events);
  await admin.getByLabel('Veranstaltung 1', { exact: true }).fill(EVENT_GALA);
  await admin.getByLabel('Veranstaltung 1: Termin').fill('Fr, 19:00');
  await admin.getByLabel('Veranstaltung 1: Obergrenze').fill('20');
  await admin.getByRole('button', { name: '+ Veranstaltung' }).click();
  await admin.getByLabel('Veranstaltung 2', { exact: true }).fill(EVENT_PARTY);
  await admin.getByLabel('Veranstaltung 2: Termin').fill('Sa, 20:00');
  await admin.getByLabel('Veranstaltung 2: Obergrenze').fill('20');

  await admin
    .getByLabel('Titel von Seite 1')
    .fill('Anmeldung zum Jahrestreffen');
  await saveForm(admin);

  for (const label of Object.values(Q)) {
    if (label === Q.table) {
      continue;
    }
    await expect(
      admin.locator('[data-question-id]').filter({ hasText: label }),
      `Nach dem Nacharbeiten muss „${label}" auf dem Zeichenbrett stehen.`,
    ).toHaveCount(1);
  }
});

/* --- step 2 -------------------------------------------------------------- */

test('Schritt 2 — eine Tabellen-Frage mit „+ Zeile", die Einstellungen, eine Benachrichtigung mit Antwortadresse, veröffentlicht', async () => {
  test.setTimeout(300_000);

  await admin.goto(`/forms/${form.id}`);
  await expect(admin.getByLabel('Formularname')).toHaveValue(FORM_TITLE);

  // --- the table, extendable (the requirements) -----------------------------
  await addQuestion(admin, 'Tabelle', Q.table);
  await admin.getByLabel('Startzeilen').fill(String(TABLE_ROWS));
  await admin.getByRole('checkbox', { name: 'Zeilen ergänzbar' }).check();
  await admin.getByLabel('Obergrenze').fill(String(TABLE_MAX_ROWS));

  /*
   * **The proof on the rendered preview**, not on the draft: with
   * the switch on, „+ Zeile" appears on the card of the question — and next to it
   * the upper limit that the person filling in really finds later.
   *
   * **Through the text and not through the role**, and that is no relapse here
   * behind "selectors by user view": the whole live preview stands under
   * `aria-hidden` (`QuestionPreview.tsx`), on purpose — it is the **image**
   * of a button and not one. `getByRole` therefore never finds it, and a
   * case that tries measures the intent of the component instead of its
   * effect. Measured on 2026-08-10: zero hits with a visible button.
   */
  const tableCard = admin
    .locator('[data-question-id]')
    .filter({ hasText: Q.table });
  await expect(
    tableCard.getByText('+ Zeile', { exact: true }),
    'Mit „Zeilen ergänzbar" zeigt die Live-Vorschau den Knopf.',
  ).toBeVisible();
  await expect(
    tableCard.getByText(`bis ${String(TABLE_MAX_ROWS)} Zeilen`),
    'Und die Obergrenze steht daneben — sonst wäre „ergänzbar" eine Zusage ' +
      'ohne Zahl.',
  ).toBeVisible();

  await saveForm(admin);
  form.path = await publishAndReadPath(admin);

  // --- the settings that step 3 needs ---------------------------------------
  await admin.goto(`/forms/${form.id}/settings`);
  const access = admin.getByRole('region', { name: 'Zugriff & Sicherheit' });
  await access.getByRole('radio', { name: 'Angepasst' }).check();
  await access
    .getByRole('switch', { name: 'Zwischenspeichern erlauben' })
    .setChecked(true);
  await access
    .getByRole('switch', { name: 'Bearbeiten nach Absenden' })
    .setChecked(true);
  await save(admin);

  // --- a notification with its own reply-to address (0.1) -------------------
  await admin.goto(`/forms/${form.id}/notifications`);
  await admin.getByRole('button', { name: '+ Neue Benachrichtigung' }).click();
  const editor = admin.getByRole('region', { name: 'Benachrichtigung' });
  await editor
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('Meldung an das Sekretariat');
  await editor
    .getByRole('textbox', { name: 'Betreff', exact: true })
    .fill(`Anmeldung ${STAMP}`);
  await editor
    .getByRole('textbox', { name: 'Text', exact: true })
    .fill('Es ist eine Anmeldung eingegangen.');
  await editor
    .getByRole('textbox', { name: /Weitere Adressen/u })
    .fill(REPLY_TO);
  await editor.getByLabel('Antwortadresse').fill(REPLY_TO);
  await admin.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(editor.getByText('Gespeichert', { exact: true })).toBeVisible();
});

/* --- step 3 -------------------------------------------------------------- */

test('Schritt 3 — ohne Sitzung ausfüllen: Zeilen ergänzen und wieder entfernen, eine Datei anhängen, zwischenspeichern, am nächsten Tag fortsetzen und absenden', async ({
  browser,
}) => {
  test.setTimeout(420_000);

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

  // --- the first context: everything up to the intermediate save ------------
  const firstContext = await browser.newContext();
  const first = await firstContext.newPage();
  try {
    await first.goto(form.path);
    /*
     * Session-less, and that is the assurance, not the backdrop (the specification).
     * The counter-check on the same route stands next to it, otherwise even a
     * typo in the path would prove the 401.
     */
    expect(
      (await first.request.get('/api/auth/me')).status(),
      'Dieser Kontext trägt keine Sitzung — ein Fremder füllt aus.',
    ).toBe(401);
    expect(
      (await admin.request.get('/api/auth/me')).status(),
      'Gegenprobe: dieselbe Route antwortet unter der geparkten Sitzung 200.',
    ).toBe(200);

    await expect(
      first.getByRole('heading', {
        level: 2,
        name: 'Anmeldung zum Jahrestreffen',
      }),
    ).toBeVisible();

    await first.getByLabel(new RegExp(Q.name, 'u')).fill('Anton Anfang');
    await first.getByLabel(new RegExp(Q.mail, 'u')).fill(PARTICIPANT_1);
    await first
      .getByRole('group', { name: new RegExp(`^${Q.choice}`, 'u') })
      .getByLabel(CHOICE_MEAT)
      .check();

    await first.getByLabel('Straße & Hausnummer').fill('Musterstraße 1');
    await first.getByLabel('PLZ', { exact: true }).fill(ZIP);
    await first.getByLabel('Ort', { exact: true }).fill('Dresden');

    /*
     * The free text that a spreadsheet program would take for a formula
     * . It stands here because step 6 has to find it again in **three**
     * files — and because it comes in through the public path,
     * just as it would in operation.
     */
    await first.getByLabel(new RegExp(Q.note, 'u')).fill(FORMULA_TEXT);

    // --- add rows and remove one again  -------------------------------------
    await first.getByLabel('Spalte 1, Zeile 1').fill('Freitag');
    await first.getByLabel('Spalte 2, Zeile 1').fill('Abendessen');
    await first.getByLabel('Spalte 1, Zeile 2').fill('Samstag');
    await first.getByLabel('Spalte 2, Zeile 2').fill('Mittagessen');

    await first.getByRole('button', { name: '+ Zeile' }).click();
    await first.getByLabel('Spalte 1, Zeile 3').fill('Sonntag');
    await first.getByLabel('Spalte 2, Zeile 3').fill('Frühstück');
    await expect(first.getByLabel('Spalte 1, Zeile 3')).toHaveValue('Sonntag');

    /*
     * **The middle row goes, not the last.** Only that way does the export in
     * step 6 measure something: the remaining rows move up, and a plan that
     * walked the *filled* rows instead of the start columns would put
     * „Sonntag" under „Zeile 3" instead of under „Zeile 2" — the file would look
     * completely plausible.
     */
    await first.getByRole('button', { name: 'Entfernen: Zeile 2' }).click();
    await expect(first.getByLabel('Spalte 1, Zeile 2')).toHaveValue('Sonntag');
    await expect(
      first.getByLabel('Spalte 1, Zeile 3'),
      'Nach dem Entfernen hat die Tabelle wieder die Startzeilenzahl.',
    ).toHaveCount(0);

    // --- the attachment -----------------------------------------------------
    await first.getByLabel(Q.file).setInputFiles({
      name: SCANNER_PDF_NAME,
      mimeType: 'application/pdf',
      buffer: SCANNER_PDF,
    });
    await expect(first.getByText(SCANNER_PDF_NAME)).toBeVisible();

    // --- the events: one with seats, one without ----------------------------
    await first.getByLabel(`${EVENT_GALA}: Anzahl Personen`).fill('1');
    await first.getByLabel(`${EVENT_PARTY}: Anzahl Personen`).fill('0');

    // --- intermediate save --------------------------------------------------
    await first.getByRole('button', { name: 'Zwischenspeichern' }).click();
    const draftBlock = first.getByTestId('public-draft-link');
    await expect(draftBlock).toBeVisible();
    const draftUrl = await draftBlock.getByRole('link').getAttribute('href');
    expect(draftUrl).toMatch(/^https?:\/\/[^/]+\/e\/[A-Za-z0-9_-]+$/u);
    draft.path = new URL(draftUrl ?? '').pathname;
    draftToken = draft.path.split('/')[2] ?? '';
    expect(draftToken).not.toBe('');
  } finally {
    await firstContext.close();
  }

  // --- "the next day": a different context, an advanced clock ---------------
  /*
   * ⚠️ **What is measured here and what is not.** At this level the only
   * movable thing is the **browser clock**; the deadlines from 0.3 (30 days
   * draft, 24 hours for a removed attachment) hang on the injected clock of the
   * **server**, which runs here as its own process. What is proven is therefore:
   * a **different** browser whose clock stands one day further on continues the
   * draft, and the attachment is still there. The deadlines themselves are
   * measured by `apps/api/test/public/draft.spec.ts` and
   * `…/draft-attachment.spec.ts` with `MutableClock` — there is no second,
   * weaker proof of them here.
   *
   * `setFixedTime` and not `install`: it sets `Date` and does not touch the
   * timers. A faked set of timers would bring React Query and the
   * announcement regions to a standstill, and the case would then lead into a
   * deadline instead of into a statement.
   */
  const nextDay = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const secondContext = await browser.newContext();
  await secondContext.clock.setFixedTime(nextDay);
  const second = await secondContext.newPage();
  try {
    await second.goto(draftPathOf());
    await expect(second.getByTestId('response-draft')).toBeVisible();
    expect(
      await second.evaluate(() => new Date().toISOString().slice(0, 10)),
      'Der zweite Kontext rechnet mit dem Datum des Folgetages.',
    ).toBe(nextDay.toISOString().slice(0, 10));

    await expect(second.getByLabel(new RegExp(Q.name, 'u'))).toHaveValue(
      'Anton Anfang',
    );
    await expect(second.getByLabel('PLZ', { exact: true })).toHaveValue(ZIP);
    await expect(second.getByLabel('Spalte 1, Zeile 2')).toHaveValue('Sonntag');
    await expect(
      second.getByText(SCANNER_PDF_NAME),
      'Die Anlage gehört dem Entwurf, nicht dem Browser, der sie hochgeladen ' +
        'hat (0.3) — sonst wäre „fortsetzen" ein Verlust.',
    ).toBeVisible();

    await second.getByRole('button', { name: 'Absenden' }).click();
    await expect(
      second.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
    ).toBeVisible();
  } finally {
    await secondContext.close();
  }
});

/* --- step 4 -------------------------------------------------------------- */

test('Schritt 4 — eine zweite Absendung mit mehr Zeilen als die erste', async ({
  browser,
}) => {
  test.setTimeout(300_000);

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(form.path);
    await page.getByLabel(new RegExp(Q.name, 'u')).fill('Bertram Bursch');
    await page.getByLabel(new RegExp(Q.mail, 'u')).fill(PARTICIPANT_2);
    await page
      .getByRole('group', { name: new RegExp(`^${Q.choice}`, 'u') })
      .getByLabel(CHOICE_VEGGIE)
      .check();
    await page.getByLabel('Straße & Hausnummer').fill('Burgweg 7');
    await page.getByLabel('PLZ', { exact: true }).fill('09112');
    await page.getByLabel('Ort', { exact: true }).fill('Chemnitz');

    /*
     * **Four rows against two** (the requirement): the column plan of the export
     * grows with the **longest** answer, not with the number of answers.
     * Were the second submission not longer, step 6 could not see the difference
     * between "plan from the form" and "plan from the answers" at all.
     */
    const days = ['Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
    for (const [index, day] of days.entries()) {
      if (index >= TABLE_ROWS) {
        await page.getByRole('button', { name: '+ Zeile' }).click();
      }
      await page.getByLabel(`Spalte 1, Zeile ${String(index + 1)}`).fill(day);
      await page
        .getByLabel(`Spalte 2, Zeile ${String(index + 1)}`)
        .fill(`Menü ${String(index + 1)}`);
    }

    await page.getByLabel(`${EVENT_GALA}: Anzahl Personen`).fill('2');
    await page.getByLabel(`${EVENT_PARTY}: Anzahl Personen`).fill('3');

    await page.getByRole('button', { name: 'Absenden' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

/* --- step 5 -------------------------------------------------------------- */

test('Schritt 5 — auswerten: Mehrfachauswahl, Detail-Panel mit Event-Chips, Löschen in den Papierkorb', async () => {
  test.setTimeout(300_000);

  await openResponses(admin, FORM_TITLE);
  const rows = admin.getByRole('row').filter({ hasText: 'Anton Anfang' });
  await expect(rows).toHaveCount(1);

  // --- multiple selection  --------------------------------------------------
  const selectAll = admin.getByLabel('Alle sichtbaren Antworten auswählen');
  await selectAll.check();
  const bar = admin.getByRole('group', { name: 'Ausgewählte Antworten' });
  await expect(
    bar,
    'Die Leiste nennt die **gerenderte** Zahl der Auswahl (der Nachweis).',
  ).toContainText('2 Antworten ausgewählt');
  await bar.getByRole('button', { name: 'Auswahl aufheben' }).click();
  await expect(bar).toHaveCount(0);

  /*
   * **"all" selects exactly the visible rows** (the proof) — the
   * most expensive mistake here would be the unfiltered set, because it deletes
   * responses that nobody has seen. Measured with the search set.
   */
  const search = admin.getByRole('searchbox', {
    name: 'Antworten durchsuchen',
  });
  await search.fill('Bertram');
  await expect(admin.getByRole('row').filter({ hasText: 'Anton' })).toHaveCount(
    0,
  );
  await selectAll.check();
  await expect(bar).toContainText('1 Antwort ausgewählt');
  await bar.getByRole('button', { name: 'Auswahl aufheben' }).click();
  await search.fill('');

  // --- detail panel with event chips  ---------------------------------------
  await admin
    .getByRole('row')
    .filter({ hasText: 'Anton Anfang' })
    .first()
    .click();
  const panel = admin.getByRole('dialog').filter({ hasText: 'Antwort' });
  await expect(panel).toBeVisible();

  const chips = panel.getByRole('listitem');
  await expect(
    chips.filter({ hasText: EVENT_GALA }),
    'Der Chip nennt Veranstaltung **und** Personenzahl.',
  ).toHaveText(`${EVENT_GALA} · 1 Person`);
  await expect(
    chips.filter({ hasText: EVENT_PARTY }),
    'Eine Anmeldung von **null** Personen ist kein Chip, auch kein leerer ' +
      '— das Sommerfest wurde mit 0 belegt.',
  ).toHaveCount(0);

  // The attachment stands as a link in the cell — the residue measurement
  // needs its address at the end (it must answer 404 afterwards).
  const attachment = panel.getByRole('link', { name: SCANNER_PDF_NAME });
  await expect(attachment).toBeVisible();
  const href = await attachment.getAttribute('href');
  expect(href).toMatch(/\/api\/responses\/files\//u);
  attachmentPath = new URL(href ?? '', 'http://localhost').pathname;

  await panel.getByRole('button', { name: 'Schließen' }).click();

  // --- delete into the trash, and back again --------------------------------
  /*
   * Deleting happens through the **selection bar**, because that is the path
   * that was newly built; restoring happens because step 6 needs both responses
   * — and because "restorable" is the promise of the trash that
   * nobody else checks in this run.
   */
  await admin
    .getByLabel(/^Antwort vom .* auswählen$/u)
    .first()
    .check();
  await expect(bar).toContainText('1 Antwort ausgewählt');
  await bar
    .getByRole('button', { name: 'Ausgewählte Antworten löschen' })
    .click();
  await bar.getByRole('button', { name: 'In den Papierkorb legen' }).click();
  await expect(
    admin.getByRole('row').filter({ hasText: '@example.invalid' }),
  ).toHaveCount(1);

  await admin.goto('/admin/trash');
  const deleted = admin
    .locator('[data-testid="trash-deleted-response"]')
    .filter({ hasText: FORM_TITLE });
  await expect(
    deleted,
    'Sammel-Löschen führt in den **Papierkorb**, nicht daran vorbei.',
  ).toHaveCount(1);
  await deleted.getByTestId('trash-restore-response').click();
  await expect(deleted).toHaveCount(0);

  await openResponses(admin, FORM_TITLE);
  await expect(
    admin.getByRole('row').filter({ hasText: '@example.invalid' }),
    'Nach dem Wiederherstellen stehen wieder beide Antworten in der Tabelle.',
  ).toHaveCount(2);
});

/* --- step 6 -------------------------------------------------------------- */

test('Schritt 6 — dreimal exportieren und die Dateien tatsächlich öffnen: CSV, Excel, HTML', async () => {
  test.setTimeout(420_000);

  await openResponses(admin, FORM_TITLE);

  /*
   * **The format choice stands at the export, and the column question stays one**
   * : three formats, **one** radio pair.
   */
  await admin.getByRole('button', { name: 'Export' }).click();
  const menu = admin.getByRole('group', { name: 'Export' });
  await expect(menu.getByRole('radio')).toHaveCount(2);
  for (const label of ['CSV', 'Excel', 'HTML']) {
    await expect(
      menu.getByRole('link', { name: label, exact: true }),
      `Das Export-Menü bietet „${label}" an.`,
    ).toBeVisible();
  }
  await expect(
    menu.getByRole('radio', { name: /Alle Spalten/u }),
    'Die Vorbelegung ist „Alle Spalten" .',
  ).toBeChecked();

  const download = async (label: string): Promise<Buffer> => {
    const waiting = admin.waitForEvent('download');
    await admin.getByRole('link', { name: label, exact: true }).click();
    const file = await waiting;
    const path = await file.path();
    const bytes = await readFile(path);
    await admin.getByRole('button', { name: 'Export' }).click();
    return bytes;
  };

  // --- CSV ------------------------------------------------------------------
  const csvBytes = await download('CSV');
  const csv = parseCsv(csvBytes.toString('utf8'));
  const header = csv[0] ?? [];
  const body = csv.slice(1);
  expect(body, 'Der Export trägt beide Antworten.').toHaveLength(2);

  /*
   * **The column blocks grow with the answer.** The plan knows a second
   * source — the answers —, so **four** row blocks stand here, although
   * the form prescribes only two start rows: the longest answer has four.
   */
  for (let row = 1; row <= 4; row += 1) {
    for (const column of ['Spalte 1', 'Spalte 2']) {
      expect(
        header,
        `Der Kopf muss „${Q.table} — ${column} (Zeile ${String(row)})" tragen ` +
          '— der Plan wächst mit der längsten Antwort, nicht mit dem Formular.',
      ).toContain(`${Q.table} — ${column} (Zeile ${String(row)})`);
    }
  }
  expect(
    header,
    'Eine fünfte Zeile hat niemand ausgefüllt; sie darf auch nicht im Kopf ' +
      'stehen (the evidence).',
  ).not.toContain(`${Q.table} — Spalte 1 (Zeile 5)`);
  for (const part of ['Straße & Hausnummer', 'PLZ', 'Ort', 'Land']) {
    expect(header).toContain(`${Q.address} — ${part}`);
  }
  for (const event of [EVENT_GALA, EVENT_PARTY]) {
    expect(header).toContain(`${Q.events} — ${event}`);
  }

  const cellsOf = (name: string): Record<string, string> => {
    const row = body.find((values) => values.includes(name));
    expect(row, `Der Export muss eine Zeile für ${name} tragen.`).toBeDefined();
    const record: Record<string, string> = {};
    header.forEach((label, index) => {
      record[label] = (row ?? [])[index] ?? '';
    });
    return record;
  };

  const anton = cellsOf('Anton Anfang');
  expect(
    anton[`${Q.address} — PLZ`],
    'Die PLZ behält ihre Null — im CSV geschützt durch das Hochkomma des ' +
      '`text`-Guards, das ein Tabellenprogramm nicht anzeigt.',
  ).toBe(`'${ZIP}`);
  expect(
    anton[Q.note],
    'Der Freitext ist geschützt, damit `=SUM(A1)` keine Formel wird.',
  ).toBe(`'${FORMULA_TEXT}`);
  expect(
    anton[`${Q.table} — Spalte 1 (Zeile 2)`],
    'Nach dem Entfernen der mittleren Zeile steht „Sonntag" unter Zeile 2 — ' +
      'nicht unter Zeile 3 (die wachsenden Spaltenblöcke).',
  ).toBe('Sonntag');
  expect(
    anton[`${Q.table} — Spalte 1 (Zeile 3)`],
    'Die kürzere Antwort trägt leere Zellen, keine verschobenen Werte.',
  ).toBe('');
  expect(anton[`${Q.events} — ${EVENT_GALA}`]).toBe('1');

  const bertram = cellsOf('Bertram Bursch');
  expect(bertram[`${Q.table} — Spalte 1 (Zeile 4)`]).toBe('Sonntag');

  // --- Excel ----------------------------------------------------------------
  const workbook = readWorkbook(await download('Excel'));
  expect(
    workbook.rowCount,
    'Die Arbeitsmappe trägt eine Kopfzeile und beide Antworten.',
  ).toBe(3);
  expect(
    workbook.hasFormula,
    'In der Excel-Datei steht **keine** Formel — `=SUM(A1)` ist Text ' +
      ', gemessen an der Datei und nicht am Bildschirm.',
  ).toBe(false);
  expect(
    workbook.values,
    "Die Zelle enthält **exakt** den eingegebenen String — ohne `'`-Präfix " +
      '(der Nachweis: doppelt geschützt ist beschädigt).',
  ).toContain(FORMULA_TEXT);
  expect(
    workbook.values,
    'Die PLZ steht als Text mit ihrer Null und ohne Hochkomma.',
  ).toContain(ZIP);
  expect(workbook.values).not.toContain(`'${ZIP}`);
  expect(workbook.values).not.toContain(`'${FORMULA_TEXT}`);
  expect(
    workbook.header,
    'Der Kopf der Arbeitsmappe ist derselbe wie im CSV — dieselbe Sicht, ' +
      'zwei Schreiber.',
  ).toEqual(header);
  expect(
    workbook.numericCells,
    'Die Personenzahl einer Veranstaltung steht als **Zahl** — sonst wäre ' +
      'Auswerten in Excel wieder Handarbeit (the evidence).',
  ).toBeGreaterThan(0);

  // --- HTML -----------------------------------------------------------------
  const html = (await download('HTML')).toString('utf8');
  expect(html).toContain(FORM_TITLE);
  expect(html, 'Der HTML-Export führt nichts aus.').not.toMatch(/<script/iu);
  expect(html).not.toMatch(/<iframe/iu);
  expect(html).not.toMatch(/\son[a-z]+\s*=/iu);
  expect(
    html,
    'Nichts wird nachgeladen: keine Adresse eines fremden Hosts.',
  ).not.toMatch(/(?:src|href)\s*=\s*["']https?:\/\//iu);
  expect(html, 'Die Stile sind eingebettet (the evidence).').toMatch(
    /<style/iu,
  );
  expect(
    html,
    'Der Freitext steht als Text da, neutralisiert statt ausgeführt.',
  ).toContain('=SUM(A1)');
  expect(html).toContain('Anton Anfang');
  expect(html).toContain('Bertram Bursch');
  expect(html).toContain(`${Q.table} — Spalte 1 (Zeile 4)`);

  await admin.keyboard.press('Escape');
});

/* --- step 7 -------------------------------------------------------------- */

test('Schritt 7 — die Antwortadresse steht im Editor und im Versandprotokoll (0.1)', async () => {
  test.setTimeout(300_000);

  // --- in the editor --------------------------------------------------------
  await admin.goto(`/forms/${form.id}/notifications`);
  const editor = admin.getByRole('region', { name: 'Benachrichtigung' });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('Antwortadresse')).toHaveValue(REPLY_TO);
  await expect(
    editor.getByTestId('effective-reply-to'),
    'Der Editor sagt, welche Adresse **wirksam** ist — die Zeile, die es vor ' +
      'nirgends im Produkt zu sehen gab.',
  ).toContainText(REPLY_TO);

  // --- in the mail dispatch log ---------------------------------------------
  await admin.goto(`/mail-log/${form.id}`);
  await expect(
    admin.getByRole('heading', { level: 1, name: 'E-Mail-Versandprotokoll' }),
  ).toBeVisible();

  const row = admin
    .locator('[data-testid^="mail-log-row-"]')
    .filter({ hasText: REPLY_TO })
    .first();
  await expect(
    row,
    'Zwei Absendungen haben je eine Zeile an das Sekretariat erzeugt — ' +
      'ohne sie gäbe es hier nichts abzulesen.',
  ).toBeVisible();
  await row.getByRole('button', { name: new RegExp(STAMP, 'u') }).click();

  await expect(
    admin.getByTestId('mail-log-reply-to'),
    'Dieselbe Adresse, zweimal abgelesen: einmal als Einstellung, einmal als ' +
      'das, was beim Einreihen wirklich in `reply_to` stand (0.1).',
  ).toContainText(REPLY_TO);
});

/* --- step 8 -------------------------------------------------------------- */

test('Schritt 8 — die Formularliste über mehrere Seiten blättern und suchen', async () => {
  test.setTimeout(420_000);

  /*
   * **Two pages come about by somebody creating forms** — through the button
   * of the dashboard, not through a seed and not through `POST /api/forms` from
   * the test file. How many are missing stands in `total`: what the rest of the
   * suite has left behind counts in, and this run only creates the difference.
   * Every filler form carries the mark and goes with the cleanup.
   */
  /*
   * **`FORM_PAGE_SIZE_DEFAULT`, here as a number** — `e2e/` deliberately keeps
   * `@formsache/shared` out (`api-dev.spec.ts` says why). So that the number
   * does not silently drift apart, it is not *believed* below but **measured**:
   * the assertion "the grid shows `pageSize` cards" is red as soon as the
   * application delivers a different page size.
   */
  const pageSize = 24;
  const total = Number(property(await readJson(admin, '/api/forms'), 'total'));
  for (let index = total; index <= pageSize; index += 1) {
    const title = `${FILLER_PREFIX} ${String(index).padStart(2, '0')}`;
    await newFormNamed(admin, title);
    fillerTitles.push(title);
  }

  await admin.goto('/');
  const pager = admin.getByRole('navigation', {
    name: 'Seiten der Formularliste',
  });
  await expect(
    pager,
    'Unter 25 Formularen gäbe es nur eine Seite — dann belegte das Blättern ' +
      'nichts.',
  ).toContainText(/Seite 1 von [2-9]/u);
  await expect(admin.getByRole('article')).toHaveCount(pageSize);

  /*
   * **What is measured is the content of the first card, not the page number.** A
   * pagination that only switches its label and leaves the same page
   * standing would not be recognizable by „Seite 2 von 2" — and exactly that
   * is the mistake this case is built against (the specification no. 75: the view renders
   * a **page**, not an organisation).
   */
  const firstPageCard = await admin.getByRole('article').first().innerText();
  await pager
    .getByRole('button', { name: 'Nächste Seite der Formularliste' })
    .click();
  await expect(pager).toContainText(/Seite 2 von /u);
  await expect
    .poll(async () => admin.getByRole('article').first().innerText(), {
      message:
        'Seite 2 zeigt andere Karten als Seite 1 — sonst blättert die ' +
        'Ansicht nur die Beschriftung um.',
    })
    .not.toBe(firstPageCard);

  // --- and the search -------------------------------------------------------
  /*
   * **The hit counter is the statement, not the number of cards** — and that
   * is the finding of this step, measured on 2026-08-10: the search
   * **pages along**. At 25 hits page 1 shows exactly `pageSize` cards,
   * and an assertion on "as many cards as hits" is wrong at every
   * hit count above one page — it would have read 24 instead of 25 here
   * and looked like a lost form.
   *
   * That is exactly specification no. 75 from the other side: the counter names the
   * hits of the **organisation**, the grid shows a **page**. A counter that
   * counted the loaded cards would say 24 here — and would not be
   * distinguishable from a missing form.
   */
  const searchField = admin.getByRole('searchbox', {
    name: 'Formulare durchsuchen',
  });
  const hits = markedTitles().length;
  await searchField.fill(STAMP);
  await expect(
    admin.getByText(`${String(hits)} Treffer für „${STAMP}"`),
    'Der Trefferzähler nennt **alle** Treffer der Organisation, nicht die Karten ' +
      'der geladenen Seite.',
  ).toBeVisible();
  await expect(
    admin.getByRole('article'),
    'Das Raster zeigt eine Seite — auch mit gesetzter Suche.',
  ).toHaveCount(Math.min(hits, pageSize));
  const searchPages = Math.ceil(hits / pageSize);
  if (searchPages > 1) {
    await expect(pager).toContainText(`Seite 1 von ${String(searchPages)}`);
  } else {
    await expect(pager).toHaveCount(0);
  }

  /*
   * And the counter-check with the **exact** title: one hit, one card, and
   * **no** pagination control. It is the deterministic half — it hangs
   * on no number that the rest of the suite could influence.
   *
   * ⚠️ **„Seite 1 von 1" does not exist** — measured on 2026-08-10, and the
   * assertion first stood there wrong. `DashboardView` draws the
   * pagination control only at `pageCount > 1` and gives its reason: "a pager over
   * one page is two dead buttons and a sentence from which nobody learns
   * anything". The right assertion is therefore the **absence**, and
   * together with the counter next to it it says the same: the pagination counts
   * the hits, not the organisation.
   */
  await searchField.fill(FORM_TITLE);
  await expect(admin.getByText(`1 Treffer für „${FORM_TITLE}"`)).toBeVisible();
  await expect(admin.getByRole('article')).toHaveCount(1);
  await expect(
    pager,
    'Bei einem Treffer gibt es nichts zu blättern — die Bedienung ist dann ' +
      'weg, nicht auf „Seite 1 von 1" gestellt.',
  ).toHaveCount(0);

  await admin.getByRole('button', { name: 'Suche zurücksetzen' }).click();
});

/* --- step 9 -------------------------------------------------------------- */

test('Schritt 9 — derselbe Weg auf 360 px: ausfüllen, auswerten, exportieren', async ({
  browser,
}) => {
  test.setTimeout(420_000);

  const MOBILE = { width: 360, height: 740 } as const;

  // --- step 3 at 360 px: fill in, with „+ Zeile" at the finger --------------
  const guestContext = await browser.newContext({
    viewport: MOBILE,
    hasTouch: true,
  });
  const guest = await guestContext.newPage();
  try {
    await guest.goto(form.path);
    await expectNoHorizontalScroll(guest, 'Ausfüllansicht (360 px)');

    await guest.getByLabel(new RegExp(Q.name, 'u')).fill('Cäsar Corps');
    await guest.getByLabel(new RegExp(Q.mail, 'u')).fill(PARTICIPANT_3);
    await guest
      .getByRole('group', { name: new RegExp(`^${Q.choice}`, 'u') })
      .getByLabel(CHOICE_MEAT)
      .tap();
    await guest.getByLabel('Straße & Hausnummer').fill('Am Markt 3');
    await guest.getByLabel('PLZ', { exact: true }).fill('04109');
    await guest.getByLabel('Ort', { exact: true }).fill('Leipzig');

    await guest.getByLabel('Spalte 1, Zeile 1').fill('Freitag');
    await guest.getByRole('button', { name: '+ Zeile' }).tap();
    await expect(
      guest.getByLabel('Spalte 1, Zeile 3'),
      '„+ Zeile" ist mit dem Finger zu bedienen.',
    ).toBeVisible();
    await guest.getByLabel('Spalte 1, Zeile 3').fill('Sonntag');
    await expectNoHorizontalScroll(
      guest,
      'Tabellenfrage nach „+ Zeile" (360 px)',
    );

    await guest.getByLabel(`${EVENT_GALA}: Anzahl Personen`).fill('1');
    await guest.getByRole('button', { name: 'Absenden' }).tap();
    await expect(
      guest.getByRole('heading', { level: 1, name: 'Vielen Dank!' }),
    ).toBeVisible();
  } finally {
    await guestContext.close();
  }

  // --- steps 5 and 6 at 360 px ----------------------------------------------
  const mobileContext = await browser.newContext({
    storageState: authStateFile,
    viewport: MOBILE,
    hasTouch: true,
  });
  const mobile = await mobileContext.newPage();
  try {
    await mobile.goto('/');
    await mobile
      .getByRole('searchbox', { name: 'Formulare durchsuchen' })
      .fill(FORM_TITLE);
    await mobile
      .getByRole('article')
      .filter({ hasText: FORM_TITLE })
      .getByRole('button', { name: 'Antworten' })
      .tap();
    await expect(
      mobile.getByRole('heading', {
        level: 1,
        name: `Antworten · ${FORM_TITLE}`,
      }),
    ).toBeVisible();
    await expectNoHorizontalScroll(mobile, 'Antworten-Ansicht (360 px)');

    // The multiple selection carries at 360 px as well.
    await mobile.getByLabel('Alle sichtbaren Antworten auswählen').tap();
    const bar = mobile.getByRole('group', { name: 'Ausgewählte Antworten' });
    await expect(bar).toContainText('3 Antworten ausgewählt');
    await expectNoHorizontalScroll(mobile, 'Auswahl-Leiste (360 px)');
    await bar.getByRole('button', { name: 'Auswahl aufheben' }).tap();

    // The format choice in the export — and a file that really arrives.
    await mobile.getByRole('button', { name: 'Export' }).tap();
    const menu = mobile.getByRole('group', { name: 'Export' });
    for (const label of ['CSV', 'Excel', 'HTML']) {
      await expect(
        menu.getByRole('link', { name: label, exact: true }),
      ).toBeVisible();
    }
    await expectNoHorizontalScroll(mobile, 'Export-Menü (360 px)');

    const waiting = mobile.waitForEvent('download');
    await menu.getByRole('link', { name: 'CSV', exact: true }).tap();
    const file = await waiting;
    const rows = parseCsv((await readFile(await file.path())).toString('utf8'));
    expect(
      rows.length,
      'Die auf 360 px heruntergeladene Datei trägt dieselbe Zeilenmenge wie ' +
        'die des Desktops — eine Kopfzeile und drei Antworten.',
    ).toBe(4);

    // And the off-canvas sheet is the path that alone exists below 1180 px.
    const { sheet } = await openMobileMenu(mobile);
    await expect(sheet.getByText('Allgemein', { exact: true })).toBeVisible();
    await expect(
      sheet.getByRole('button', { name: /KI-Formular/u }),
      'Ohne Schlüssel steht der Eintrag auch mobil nicht im Sheet.',
    ).toHaveCount(0);
  } finally {
    await mobileContext.close();
  }
});
