import request from 'supertest';
import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EMPTY_LEGAL_DOCUMENT,
  LEGAL_FILL_MAX,
  LEGAL_TEXT_MAX,
  readValidationProblem,
  toFieldIssues,
  type LegalDocument,
} from '@formsache/shared';

import { Prisma } from '@prisma/client';

import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import {
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, openSession } from '../support/http';
import { validationPaths } from '../support/validation';

/**
 * **The shape of a refused legal-text write** — the paths a 400 carries, run
 * against a real server (ADR-0028 no. 9).
 *
 * The field marking in the interface hangs on a promise nothing measured: a
 * refused legal text names the field it failed on, under
 * `pages.<seite>.custom` and `pages.<seite>.fills.<SCHLÜSSEL>`. Both cards of
 * an organisation — three of the installation — travel in **one** `PUT`, so the
 * page name in the path is not decoration: it is what decides which card gets
 * marked. `TenantLegalTab` and `SystemLegalTab` narrow the messages with
 * `issuesUnder(issues, \`pages.${page}.\`)`, and `LegalPageEditor` then asks
 * for `custom` and `fills.<SCHLÜSSEL>`.
 *
 * Until now that chain — `TenantLegalController` → `parseRequest` →
 * `validationProblem` → `issue.path.join('.')` — was readable in the source and
 * measured nowhere. Whoever changed `parseRequest`, the schema or the assembly
 * of `validationProblem` left the API green while the marking in the interface
 * pointed at the wrong field, or at none.
 *
 * **The one deliberate copy in this file** is `issuesUnder` below. Two lines of
 * the browser's `api-messages.ts`, restated so that this suite can measure the
 * *whole* way from server path to control name. The verbatim path assertions
 * beside it are the primary statement; the copy only shows what the interface
 * makes of them, and a copy that drifted would be caught by them.
 *
 * ## Gegenprobe
 *
 * `toValidationIssues` (`packages/shared/src/problem.ts`) shortened to the last
 * segment of the path — `path: issue.path.at(-1) ?? ''` instead of
 * `issue.path.join('.')` — and **every one of the six cases below turns red**,
 * each on its first assertion, the one that spells the path out:
 *
 * - `custom` arrives instead of `pages.privacy.custom`,
 * - `STRASSE_UND_HAUSNUMMER` instead of
 *   `pages.imprint.fills.STRASSE_UND_HAUSNUMMER`,
 * - and in the two cases where two cards fail at once, `custom` and `STAND`
 *   arrive side by side with nothing left in them that says which card was
 *   meant.
 *
 * What the interface would then do is the second half of the same measurement,
 * and it is the quiet failure this file is built for: `issuesUnder` finds
 * nothing under `pages.imprint.` or `pages.privacy.` any more, so the save is
 * refused, „Bitte die markierten Felder prüfen." appears — and **not one field
 * is marked**. Nothing about that is red without the assertions below.
 *
 * Measured on 2026-08-20 against the two schemas and `validationProblem`
 * itself — the half of the chain that lives in `packages/shared`.
 */

const PASSWORD = 'test-password';
const TENANT_LEGAL = apiPath('/tenant/legal');
const SYSTEM_LEGAL = apiPath('/admin/system-settings/legal');

/** A text that `LEGAL_TEXT_MAX` refuses — one character over the line. */
const TOO_LONG_TEXT = 'x'.repeat(LEGAL_TEXT_MAX + 1);
/** A placeholder value that `LEGAL_FILL_MAX` refuses. */
const TOO_LONG_FILL = 'y'.repeat(LEGAL_FILL_MAX + 1);

function own(custom: string): LegalDocument {
  return { ...EMPTY_LEGAL_DOCUMENT, mode: 'custom', custom };
}

function filled(fills: Record<string, string>): LegalDocument {
  return { ...EMPTY_LEGAL_DOCUMENT, fills };
}

/** Ein Verweis auf eine eigene Seite (Review-Runde 5, Nachtrag). */
function linked(link: string): LegalDocument {
  return { ...EMPTY_LEGAL_DOCUMENT, mode: 'link', link };
}

/**
 * What `LegalPageEditor` sees for one card — the browser's `issuesUnder`
 * (`apps/web/src/views/api-messages.ts`), restated here on purpose (see the
 * head of this file).
 */
function issuesUnder(
  issues: Record<string, string>,
  prefix: string,
): Record<string, string> {
  const nested: Record<string, string> = {};
  for (const [path, message] of Object.entries(issues)) {
    if (path.startsWith(prefix)) {
      nested[path.slice(prefix.length)] = message;
    }
  }
  return nested;
}

function fieldIssuesOf(body: unknown): Record<string, string> {
  const problem = readValidationProblem(body);
  return problem === undefined ? {} : toFieldIssues(problem);
}

describe('die Pfade einer abgewiesenen Rechtstext-Schreibung', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let alpha: TenantFixture;
  let superadmin: string;
  let tenantAdmin: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'LEGP');

    const root = await createUser(testApp.prisma, {
      email: 'pfade-root@example.org',
      password: PASSWORD,
      isSuperadmin: true,
    });
    superadmin = await openSession(testApp, root.id, alpha.id);

    const admin = await createUser(testApp.prisma, {
      email: 'pfade-admin@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    tenantAdmin = await openSession(testApp, admin.id, alpha.id);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  afterEach(async () => {
    await app().prisma.systemSetting.deleteMany({});
    await app().prisma.tenant.updateMany({
      // `Prisma.DbNull`, not `null` — SQL NULL is what "nichts hinterlegt"
      // means on a JSON column.
      data: { legalPages: Prisma.DbNull, legalRevision: 1 },
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The organisation — two cards, one PUT
  // ═════════════════════════════════════════════════════════════════════════

  describe('bei der Organisation', () => {
    it('nennt den eigenen Text der Datenschutzerklärung als „pages.privacy.custom" — und nicht das Impressum', async () => {
      const response = await request(app().server)
        .put(TENANT_LEGAL)
        .set(authedMutation(tenantAdmin))
        .send({
          pages: {
            // Well within the limit: the imprint has nothing to complain
            // about, so a path naming it could only come from a mix-up.
            imprint: own('Ein kurzer eigener Text.'),
            privacy: own(TOO_LONG_TEXT),
          },
          lock: 1,
        });

      const paths = validationPaths(response.status, response.body);
      expect(paths).toEqual(['pages.privacy.custom']);

      // The interface reads it this way: the Datenschutz card is marked on its
      // own text, the Impressum card is not marked at all.
      const issues = fieldIssuesOf(response.body);
      expect(Object.keys(issuesUnder(issues, 'pages.privacy.'))).toEqual([
        'custom',
      ]);
      expect(issuesUnder(issues, 'pages.imprint.')).toEqual({});

      // A refused write is a write that did not happen.
      const row = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: alpha.id },
        select: { legalPages: true },
      });
      expect(row.legalPages).toBeNull();
    });

    /**
     * **Der dritte Weg hat einen dritten Pfad** (Review-Runde 5, Nachtrag).
     *
     * Ein Verweis ist ein Feld wie die beiden anderen Hälften, und ein
     * abgewiesener Verweis muss an *seinem* Feld landen — sonst endete er
     * wieder bei „Bitte die markierten Felder prüfen" ohne Markierung
     * (ADR-0028 Nr. 9). Gemessen an einem Ziel, dem kein Browser folgen darf:
     * `javascript:` ist der Fall, gegen den die Prüfung überhaupt existiert.
     */
    it('nennt eine unbrauchbare Adresse als „pages.imprint.link"', async () => {
      const response = await request(app().server)
        .put(TENANT_LEGAL)
        .set(authedMutation(tenantAdmin))
        .send({
          pages: {
            imprint: linked('javascript:alert(1)'),
            privacy: EMPTY_LEGAL_DOCUMENT,
          },
          lock: 1,
        });

      expect(validationPaths(response.status, response.body)).toEqual([
        'pages.imprint.link',
      ]);
      expect(
        Object.keys(
          issuesUnder(fieldIssuesOf(response.body), 'pages.imprint.'),
        ),
      ).toEqual(['link']);

      const row = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: alpha.id },
        select: { legalPages: true },
      });
      expect(row.legalPages).toBeNull();
    });

    it('nennt einen zu langen Platzhalterwert als „pages.imprint.fills.STRASSE_UND_HAUSNUMMER"', async () => {
      const response = await request(app().server)
        .put(TENANT_LEGAL)
        .set(authedMutation(tenantAdmin))
        .send({
          pages: {
            imprint: filled({
              ORT: 'Musterstadt',
              STRASSE_UND_HAUSNUMMER: TOO_LONG_FILL,
            }),
            privacy: EMPTY_LEGAL_DOCUMENT,
          },
          lock: 1,
        });

      const paths = validationPaths(response.status, response.body);
      expect(paths).toEqual(['pages.imprint.fills.STRASSE_UND_HAUSNUMMER']);

      const issues = fieldIssuesOf(response.body);
      // The name under which `LegalPageEditor` asks for exactly this input.
      expect(Object.keys(issuesUnder(issues, 'pages.imprint.'))).toEqual([
        'fills.STRASSE_UND_HAUSNUMMER',
      ]);
      expect(issuesUnder(issues, 'pages.privacy.')).toEqual({});
    });

    it('hält zwei fehlerhafte Seiten einer Anfrage auseinander', async () => {
      const response = await request(app().server)
        .put(TENANT_LEGAL)
        .set(authedMutation(tenantAdmin))
        .send({
          pages: {
            imprint: own(TOO_LONG_TEXT),
            privacy: filled({ STAND: TOO_LONG_FILL }),
          },
          lock: 1,
        });

      const paths = validationPaths(response.status, response.body);
      // Sorted, because the order of the issues is the schema's business and
      // not a promise this file wants to freeze.
      expect([...paths].sort()).toEqual([
        'pages.imprint.custom',
        'pages.privacy.fills.STAND',
      ]);
      expect(readValidationProblem(response.body)?.issueCount).toBe(2);

      // Each card gets its own finding — and only its own. This is the
      // collision that a path without the page name would produce.
      const issues = fieldIssuesOf(response.body);
      expect(Object.keys(issuesUnder(issues, 'pages.imprint.'))).toEqual([
        'custom',
      ]);
      expect(Object.keys(issuesUnder(issues, 'pages.privacy.'))).toEqual([
        'fills.STAND',
      ]);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The installation — the same assembly, two cards
  // ═════════════════════════════════════════════════════════════════════════

  describe('bei der Installation', () => {
    it('nennt den eigenen Text der Datenschutzerklärung als „pages.privacy.custom"', async () => {
      const response = await request(app().server)
        .put(SYSTEM_LEGAL)
        .set(authedMutation(superadmin))
        .send({
          pages: {
            imprint: own('Kurz.'),
            privacy: own(TOO_LONG_TEXT),
          },
          lock: 1,
        });

      const paths = validationPaths(response.status, response.body);
      expect(paths).toEqual(['pages.privacy.custom']);

      const issues = fieldIssuesOf(response.body);
      expect(Object.keys(issuesUnder(issues, 'pages.privacy.'))).toEqual([
        'custom',
      ]);
      expect(issuesUnder(issues, 'pages.imprint.')).toEqual({});

      expect(await app().prisma.systemSetting.count()).toBe(0);
    });

    it('nennt einen zu langen Platzhalterwert als „pages.privacy.fills.NAME_DES_BETREIBERS"', async () => {
      const response = await request(app().server)
        .put(SYSTEM_LEGAL)
        .set(authedMutation(superadmin))
        .send({
          pages: {
            imprint: filled({ NAME_DES_BETREIBERS: 'Beispiel-Betrieb e. V.' }),
            privacy: filled({ NAME_DES_BETREIBERS: TOO_LONG_FILL }),
          },
          lock: 1,
        });

      const paths = validationPaths(response.status, response.body);
      // ⚠️ The same placeholder key stands on both cards. Without
      // the page name in the path, the finding would be shown on the Impressum
      // as well — where the value is perfectly fine.
      expect(paths).toEqual(['pages.privacy.fills.NAME_DES_BETREIBERS']);

      const issues = fieldIssuesOf(response.body);
      expect(Object.keys(issuesUnder(issues, 'pages.privacy.'))).toEqual([
        'fills.NAME_DES_BETREIBERS',
      ]);
      expect(issuesUnder(issues, 'pages.imprint.')).toEqual({});
    });

    it('hält die beiden Karten auseinander und benennt beide Fehler getrennt', async () => {
      const response = await request(app().server)
        .put(SYSTEM_LEGAL)
        .set(authedMutation(superadmin))
        .send({
          pages: {
            imprint: filled({ TELEFONNUMMER: TOO_LONG_FILL }),
            privacy: own(TOO_LONG_TEXT),
          },
          lock: 1,
        });

      const paths = validationPaths(response.status, response.body);
      expect([...paths].sort()).toEqual([
        'pages.imprint.fills.TELEFONNUMMER',
        'pages.privacy.custom',
      ]);

      const issues = fieldIssuesOf(response.body);
      expect(Object.keys(issuesUnder(issues, 'pages.imprint.'))).toEqual([
        'fills.TELEFONNUMMER',
      ]);
      expect(Object.keys(issuesUnder(issues, 'pages.privacy.'))).toEqual([
        'custom',
      ]);
    });
  });
});
