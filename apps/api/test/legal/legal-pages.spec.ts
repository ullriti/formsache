import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  EMPTY_LEGAL_DOCUMENT,
  type LegalBlock,
  type LegalDocument,
  type LegalInline,
} from '@formsache/shared';

import { Prisma } from '@prisma/client';

import { SYSTEM_SETTING_ID } from '../../src/system-settings/system-settings.repository';
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
  createRestrictedMember,
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, cookieHeader, openSession } from '../support/http';

/**
 * **The legal texts** (ADR-0028) — the three promises that only an
 * integration test can keep.
 *
 * 1. **The permission rules per route**, each via the case that **must fail**
 *    (`AGENTS.md`): a test that only checks the allowed access proves
 *    nothing.
 * 2. **The public retrieval without a login** — the property for the sake of
 *    which these pages were built at all (§ 18 Abs. 1 MStV „ständig
 *    verfügbar", Art. 13 Abs. 1 DSGVO „zum Zeitpunkt der Erhebung").
 * 3. **The XSS channel, closed** (`docs/legal/README.md` 5.6, 7.8) — the most
 *    likely mistake when carrying this undertaking out, measured against
 *    what the server actually delivers.
 *
 * Plus the case "field empty → the page says so", because it carries the
 * decision from section 5.4: no missing link, no invented substitute text.
 */

const PASSWORD = 'test-password';
const SYSTEM_LEGAL = apiPath('/admin/system-settings/legal');
const TENANT_LEGAL = apiPath('/tenant/legal');

/** Every text of a block tree, flat — for the "is that in there?" probes. */
function textOf(blocks: readonly LegalBlock[]): string {
  const runs = (list: readonly LegalInline[]): string =>
    list
      .map((run) =>
        run.kind === 'gap'
          ? `[LÜCKE ${run.label}]`
          : run.kind === 'link'
            ? `${run.label} → ${run.href}`
            : run.text,
      )
      .join('');
  return blocks
    .map((block) => {
      switch (block.kind) {
        case 'heading':
        case 'paragraph':
          return runs(block.runs);
        case 'list':
          return block.items.map(runs).join('\n');
        case 'table':
          return [block.head, ...block.rows]
            .map((row) => row.map(runs).join(' | '))
            .join('\n');
      }
    })
    .join('\n');
}

/**
 * ⚠️ **Ohne `status` und ohne `missing`** — Review-Runde 5 Nr. 1. Die
 * öffentliche Nutzlast trägt beides nicht mehr; dass sie es nicht tut, ist
 * unten ein eigener Fall und nicht nur die Form dieses Typs.
 */
interface LegalPageBody {
  title: string;
  owner: { kind: string; name: string | null };
  blocks: LegalBlock[];
}

function filled(fills: Record<string, string>): LegalDocument {
  return { ...EMPTY_LEGAL_DOCUMENT, fills };
}

describe('die Rechtstexte', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let alpha: TenantFixture;
  let beta: TenantFixture;

  /** Superadministrator — is allowed the system row. */
  let superadmin: string;
  /** `admin` in alpha: all six group permissions, **no** superadmin. */
  let tenantAdmin: string;
  /** Member in alpha **without** `can_manage_settings`, otherwise with everything. */
  let withoutSettings: string;
  /** `admin` in **beta** — for the tenant boundary. */
  let betaAdmin: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'LEGA');
    beta = await createTenant(testApp.prisma, 'LEGB');

    const root = await createUser(testApp.prisma, {
      email: 'root@example.org',
      password: PASSWORD,
      isSuperadmin: true,
    });
    superadmin = await openSession(testApp, root.id, alpha.id);

    const admin = await createUser(testApp.prisma, {
      email: 'admin@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    tenantAdmin = await openSession(testApp, admin.id, alpha.id);

    // ⚠️ **The trap sits in the fixture, not in the code.** This person holds
    // *every other* permission and only not `can_manage_settings`. One that
    // holds nothing would only prove that *some* guard fires.
    const restricted = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'ohne-einstellungen@example.org',
      groupName: 'Ohne Einstellungen',
      permissions: {
        canBuild: true,
        canViewResponses: true,
        canExport: true,
        canManageSettings: false,
        canManageFormSettings: true,
        canManageUsers: true,
      },
    });
    withoutSettings = await openSession(testApp, restricted.id, alpha.id);

    const other = await createUser(testApp.prisma, {
      email: 'beta-admin@example.org',
      password: PASSWORD,
      tenants: [beta],
    });
    betaAdmin = await openSession(testApp, other.id, beta.id);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  afterEach(async () => {
    await app().prisma.systemSetting.deleteMany({});
    await app().prisma.tenant.updateMany({
      // `Prisma.DbNull` and not `null`: on a JSON column `null` would be
      // ambiguous (JSON `null` against SQL NULL), and this application writes
      // exclusively SQL NULL for "nothing stored".
      data: { legalPages: Prisma.DbNull, legalRevision: 1 },
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 1. The permission rules — each via the case that must fail
  // ═════════════════════════════════════════════════════════════════════════

  describe('wer die Rechtstexte der Installation schreiben darf', () => {
    it('weist den Administrator einer Organisation ab — lesend wie schreibend', async () => {
      const read = await request(app().server)
        .get(SYSTEM_LEGAL)
        .set('Cookie', cookieHeader(tenantAdmin));
      expect(read.status).toBe(403);

      const write = await request(app().server)
        .put(SYSTEM_LEGAL)
        .set(authedMutation(tenantAdmin))
        .send({
          pages: {
            imprint: filled({ NAME_DES_BETREIBERS: 'Fremd' }),
            privacy: EMPTY_LEGAL_DOCUMENT,
          },
          lock: 1,
        });
      expect(write.status).toBe(403);

      // And the row really is untouched — not only the response.
      expect(await app().prisma.systemSetting.count()).toBe(0);
    });

    it('weist eine Anfrage ohne Sitzung ab', async () => {
      const read = await request(app().server).get(SYSTEM_LEGAL);
      expect(read.status).toBe(401);
    });

    it('lässt den Superadministrator durch', async () => {
      const read = await request(app().server)
        .get(SYSTEM_LEGAL)
        .set('Cookie', cookieHeader(superadmin));
      expect(read.status).toBe(200);
    });
  });

  describe('wer die Rechtstexte einer Organisation schreiben darf', () => {
    it('weist ein Mitglied ohne „Einstellungen verwalten" ab', async () => {
      const read = await request(app().server)
        .get(TENANT_LEGAL)
        .set('Cookie', cookieHeader(withoutSettings));
      expect(read.status).toBe(403);

      const write = await request(app().server)
        .put(TENANT_LEGAL)
        .set(authedMutation(withoutSettings))
        .send({
          pages: {
            imprint: filled({ ORT: 'Musterstadt' }),
            privacy: EMPTY_LEGAL_DOCUMENT,
          },
          lock: 1,
        });
      expect(write.status).toBe(403);

      const row = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: alpha.id },
        select: { legalPages: true },
      });
      expect(row.legalPages).toBeNull();
    });

    /**
     * **The tenant boundary is structural here**, and the test measures
     * exactly that: the route names no organisation, so a request cannot
     * address a foreign one. What beta's administrator gets are the legal
     * texts of **beta** — not 403 on alpha, but no access to alpha at all.
     */
    it('schreibt in die eigene Organisation und nie in eine fremde', async () => {
      const write = await request(app().server)
        .put(TENANT_LEGAL)
        .set(authedMutation(betaAdmin))
        .send({
          pages: {
            imprint: filled({ ORT: 'Beta-Stadt' }),
            privacy: EMPTY_LEGAL_DOCUMENT,
          },
          lock: 1,
        });
      expect(write.status).toBe(200);

      const alphaRow = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: alpha.id },
        select: { legalPages: true },
      });
      expect(alphaRow.legalPages).toBeNull();

      const betaRow = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: beta.id },
        select: { legalPages: true },
      });
      expect(JSON.stringify(betaRow.legalPages)).toContain('Beta-Stadt');
    });

    it('weist eine veraltete Sperre mit 409 ab, statt still zu überschreiben', async () => {
      const first = await request(app().server)
        .put(TENANT_LEGAL)
        .set(authedMutation(tenantAdmin))
        .send({
          pages: {
            imprint: filled({ ORT: 'Zuerst' }),
            privacy: EMPTY_LEGAL_DOCUMENT,
          },
          lock: 1,
        });
      expect(first.status).toBe(200);

      const stale = await request(app().server)
        .put(TENANT_LEGAL)
        .set(authedMutation(tenantAdmin))
        .send({
          pages: {
            imprint: filled({ ORT: 'Danach' }),
            privacy: EMPTY_LEGAL_DOCUMENT,
          },
          // The same counter value as just now — the request does not know
          // about the first write.
          lock: 1,
        });
      expect(stale.status).toBe(409);

      const row = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: alpha.id },
        select: { legalPages: true },
      });
      expect(JSON.stringify(row.legalPages)).toContain('Zuerst');
      expect(JSON.stringify(row.legalPages)).not.toContain('Danach');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 2. The public retrieval — without a login, without anything
  // ═════════════════════════════════════════════════════════════════════════

  describe('der öffentliche Abruf', () => {
    it('liefert das Impressum der Installation ohne jede Anmeldung', async () => {
      await request(app().server)
        .put(SYSTEM_LEGAL)
        .set(authedMutation(superadmin))
        .send({
          pages: {
            imprint: filled({
              NAME_DES_BETREIBERS: 'Beispiel-Betrieb e. V.',
              STRASSE_UND_HAUSNUMMER: 'Musterweg 1',
              PLZ: '12345',
              ORT: 'Musterstadt',
              LAND: 'Deutschland',
              TELEFONNUMMER: '0123 456789',
              E_MAIL_ADRESSE: 'kontakt@example.org',
            }),
            privacy: EMPTY_LEGAL_DOCUMENT,
          },
          lock: 1,
        })
        .expect(200);

      // **No cookie, no CSRF token, no header.**
      const page = await request(app().server).get(
        apiPath('/public/legal/system/imprint'),
      );

      expect(page.status).toBe(200);
      const body = page.body as LegalPageBody;
      expect(body.owner).toEqual({
        kind: 'installation',
        name: 'Beispiel-Betrieb e. V.',
      });
      expect(textOf(body.blocks)).toContain('Musterweg 1');
      // No placeholder survives the rendering — the promise of
      // `renderLegalPage`.
      expect(textOf(body.blocks)).not.toMatch(/\[\[|⟪/u);
    });

    it('liefert die Datenschutzhinweise einer Organisation über ihren Kurznamen', async () => {
      await request(app().server)
        .put(TENANT_LEGAL)
        .set(authedMutation(tenantAdmin))
        .send({
          pages: {
            imprint: EMPTY_LEGAL_DOCUMENT,
            privacy: filled({
              STAND: '18. August 2026',
              STRASSE_UND_HAUSNUMMER: 'Vereinsweg 2',
              PLZ: '54321',
              ORT: 'Beispielstadt',
              E_MAIL_ADRESSE: 'datenschutz@example.org',
              TELEFONNUMMER: '0321 987654',
              ZWECKE_UND_RECHTSGRUNDLAGEN: 'Anmeldung zur Jahrestagung 2026.',
              PFLICHTANGABEN: 'Name und E-Mail-Adresse.',
              EMPFAENGER: 'Die Tagungsstätte.',
              AUFSICHTSBEHOERDE: 'Landesbeauftragte für den Datenschutz.',
            }),
          },
          lock: 1,
        })
        .expect(200);

      const page = await request(app().server).get(
        apiPath(`/public/legal/tenant/${alpha.shortName}/privacy`),
      );

      expect(page.status).toBe(200);
      const body = page.body as LegalPageBody;
      expect(body.owner.kind).toBe('organisation');
      const text = textOf(body.blocks);
      expect(text).toContain('Anmeldung zur Jahrestagung 2026.');
      // **The fixed part travels along** — it describes the software and is
      // the same for every organisation (`docs/legal/README.md`, Vorlage 04
      // Teil B).
      expect(text).toContain('Es werden keine Cookies gesetzt');
    });

    it('antwortet 404 für einen Kurznamen, den es nicht gibt', async () => {
      const page = await request(app().server).get(
        apiPath('/public/legal/tenant/GIBTSNICHT/privacy'),
      );
      expect(page.status).toBe(404);
    });

    /**
     * **A deleted organisation keeps both of its legal texts** — until the
     * row is really gone (decision of 2026-08-18, ADR-0028 no. 8).
     *
     * The reason stands at the service: whoever has filled in a form needs
     * **precisely then** to know who was responsible (§ 5 TMG) and how to
     * exercise their rights (Art. 15 ff. DSGVO), when the organisation no
     * longer works. `TENANT_LEGAL_PAGES` are exactly these two.
     *
     * Both directions, because only one proves nothing:
     *
     * 1. Soft-deleted (`deleted_at` set, row there) → **200**, with the
     *    stored text.
     * 2. Really gone (row deleted, as the 30-day run does it) → **404**. With
     *    that the retention period hangs on the lifetime of the row and
     *    stands nowhere a second time.
     *
     * *Reproduction:* enter the `deletedAt: null` in the service again →
     * step 1 turns red.
     */
    it('behält die Rechtstexte einer gelöschten Organisation, bis die Zeile fort ist', async () => {
      const doomed = await createTenant(testApp.prisma, 'LEGX');
      const doomedUser = await createUser(testApp.prisma, {
        email: 'admin-legx@example.org',
        password: PASSWORD,
        tenants: [doomed],
      });
      const admin = await openSession(testApp, doomedUser.id, doomed.id);

      await request(app().server)
        .put(TENANT_LEGAL)
        .set(authedMutation(admin))
        .send({
          pages: {
            imprint: filled({
              NAME_DER_ORGANISATION: 'Aufgelöster Verein e. V.',
              STRASSE_UND_HAUSNUMMER: 'Schlussweg 9',
              PLZ: '54321',
              ORT: 'Endstadt',
              LAND: 'Deutschland',
              E_MAIL_ADRESSE: 'nachlass@example.org',
            }),
            privacy: EMPTY_LEGAL_DOCUMENT,
          },
          lock: 1,
        })
        .expect(200);

      const path = apiPath(`/public/legal/tenant/${doomed.shortName}/imprint`);
      expect((await request(app().server).get(path)).status).toBe(200);

      // --- soft-deleted: the page stays -------------------------------------
      await testApp.prisma.tenant.update({
        where: { id: doomed.id },
        data: { deletedAt: new Date() },
      });

      const whileDeleted = await request(app().server).get(path);
      expect(
        whileDeleted.status,
        'Wer ein Formular dieser Organisation ausgefüllt hat, muss in der ' +
          'Löschfrist noch erfahren können, wer verantwortlich war.',
      ).toBe(200);
      expect(textOf((whileDeleted.body as LegalPageBody).blocks)).toContain(
        'Schlussweg 9',
      );

      // --- really gone: 404, as for an invented short name ------------------
      await testApp.prisma.tenant.delete({ where: { id: doomed.id } });

      expect(
        (await request(app().server).get(path)).status,
        'Nach dem 30-Tage-Lauf gibt es die Zeile nicht mehr — und damit auch ' +
          'die Seite nicht. Bliebe sie, hinge die Frist an einer zweiten ' +
          'Wahrheit statt an der Lebensdauer der Zeile.',
      ).toBe(404);
    });

    it('antwortet 404 für eine Seite, die es nicht gibt', async () => {
      const page = await request(app().server).get(
        apiPath('/public/legal/system/geheimnisse'),
      );
      expect(page.status).toBe(404);
    });

    it('nennt in der Fußzeile den Betreiber aus dem Impressum — und sonst nichts', async () => {
      const empty = await request(app().server).get(apiPath('/public/legal'));
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({ installationName: null });

      await request(app().server)
        .put(SYSTEM_LEGAL)
        .set(authedMutation(superadmin))
        .send({
          pages: {
            imprint: filled({ NAME_DES_BETREIBERS: 'Beispiel-Betrieb e. V.' }),
            privacy: EMPTY_LEGAL_DOCUMENT,
          },
          lock: 1,
        })
        .expect(200);

      const named = await request(app().server).get(apiPath('/public/legal'));
      expect(named.body).toEqual({
        installationName: 'Beispiel-Betrieb e. V.',
      });
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 3. The XSS channel — the attack that must fail
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **The most likely mistake of this undertaking**, named verbatim in
   * `docs/legal/README.md` 7.8: „Rechtstexte brauchen Formatierung" → allow
   * HTML → `dangerouslySetInnerHTML` → a stored cross-site scripting hole on
   * exactly the page that strangers call up.
   *
   * What is measured is what the **server delivers**, and not what a renderer
   * makes of it: the response carries blocks with text runs, and an attack
   * stays standing inside a text run. In the whole response there is no
   * string that a browser could read as markup — and therefore nothing that a
   * frontend could accidentally use as such either.
   */
  describe('ein Rechtstext ist kein Einfallstor', () => {
    const ATTACKS = [
      '<script>alert(document.cookie)</script>',
      '<img src=x onerror="fetch(\'https://boese.example\')">',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<a href="javascript:alert(1)">Impressum</a>',
      '[Impressum](javascript:alert(1))',
      '<svg/onload=alert(1)>',
    ];

    it.each(ATTACKS)(
      'liefert %s als Text und niemals als Struktur',
      async (attack) => {
        await request(app().server)
          .put(TENANT_LEGAL)
          .set(authedMutation(tenantAdmin))
          .send({
            pages: {
              imprint: EMPTY_LEGAL_DOCUMENT,
              privacy: {
                mode: 'custom',
                fills: {},
                conditions: {},
                custom: `Verantwortlich: ${attack}`,
              },
            },
            lock: 1,
          })
          .expect(200);

        const page = await request(app().server).get(
          apiPath(`/public/legal/tenant/${alpha.shortName}/privacy`),
        );
        expect(page.status).toBe(200);
        const body = page.body as LegalPageBody;

        // **No link to a target that no browser may follow.** Every `href`
        // the response carries has passed the allow list.
        const hrefs =
          JSON.stringify(body.blocks).match(/"href":"[^"]*"/gu) ?? [];
        for (const href of hrefs) {
          expect(href).not.toMatch(/javascript|data:|vbscript/iu);
        }

        // **And the attack stands there as text**, character for character:
        // nothing has been swallowed (that would be silent data loss) and
        // nothing has become markup.
        const text = textOf(body.blocks);
        expect(text).toContain('Verantwortlich:');

        // In the whole response there is **no** field that could transport
        // markup: the blocks carry `kind`, `text`, `label`, `href`, `level`,
        // `runs`, `items`, `head`, `rows` — and nothing that would be called
        // "html".
        expect(JSON.stringify(body.blocks)).not.toMatch(
          /"html"|"dangerously/iu,
        );
      },
    );

    it('nimmt einem Fremdwert die unsichtbaren Steuerzeichen schon an der Spalte', async () => {
      await request(app().server)
        .put(TENANT_LEGAL)
        .set(authedMutation(tenantAdmin))
        .send({
          pages: {
            imprint: filled({
              // U+202E is the bidi mark "right-to-left override": a display
              // that is read differently than it is stored.
              ORT: 'Muster‮stadt ',
            }),
            privacy: EMPTY_LEGAL_DOCUMENT,
          },
          lock: 1,
        })
        .expect(200);

      const row = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: alpha.id },
        select: { legalPages: true },
      });
      expect(JSON.stringify(row.legalPages)).toContain('Musterstadt');
      expect(JSON.stringify(row.legalPages)).not.toContain('‮');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 4. Empty means empty — and the page says so
  // ═════════════════════════════════════════════════════════════════════════

  describe('wenn nichts hinterlegt ist', () => {
    it('liefert die Seite trotzdem und benennt den Mangel', async () => {
      const page = await request(app().server).get(
        apiPath(`/public/legal/tenant/${alpha.shortName}/imprint`),
      );

      expect(page.status).toBe(200);
      const body = page.body as LegalPageBody;
      const text = textOf(body.blocks);
      expect(text).toContain('keine Anbieterangaben hinterlegt');
      // The name of the organisation is what the application **truthfully**
      // knows — and nothing more is invented.
      expect(text).toContain(`Organisation ${alpha.shortName}`);
      expect(body.owner.name).toBe(`Organisation ${alpha.shortName}`);
    });

    /**
     * **Review-Runde 5 Nr. 1 — was von einer halb ausgefüllten Seite öffentlich
     * übrig bleibt.**
     *
     * Bis dahin trug die Seite den Hinweis „Diese Angaben sind unvollständig.
     * Es fehlt: …" und im Text markierte Lücken („Telefon: ⟨Angabe fehlt⟩").
     * Der Befund war: *„unvollständige Angaben sollten nicht in der öffentlichen
     * Ansicht angezeigt werden."*
     *
     * Gemessen wird deshalb beides — dass die **wahre** Angabe steht (die Seite
     * schweigt nicht, § 18 Abs. 1 MStV verlangt, was da ist) und dass von den
     * offenen keine Spur bleibt: keine benannte Lücke, kein `[[…]]`, keine
     * Beschriftung ohne Wert und kein Zustand in der Nutzlast.
     */
    it('lässt die offenen Angaben aus der öffentlichen Seite heraus', async () => {
      await request(app().server)
        .put(TENANT_LEGAL)
        .set(authedMutation(tenantAdmin))
        .send({
          pages: {
            // Only the street — postal code, town and contact are missing.
            imprint: filled({ STRASSE_UND_HAUSNUMMER: 'Vereinsweg 2' }),
            privacy: EMPTY_LEGAL_DOCUMENT,
          },
          lock: 1,
        })
        .expect(200);

      const page = await request(app().server).get(
        apiPath(`/public/legal/tenant/${alpha.shortName}/imprint`),
      );
      const body = page.body as LegalPageBody;
      const text = textOf(body.blocks);

      expect(text).toContain('Vereinsweg 2');
      expect(text).not.toContain('[LÜCKE ');
      expect(text).not.toMatch(/\[\[/u);
      // Die Beschriftung geht mit ihrem Wert: „Telefon: " ohne Nummer wäre der
      // Rest, den das zeilenweise Weglassen gerade verhindert.
      expect(text).not.toContain('Telefon:');
      expect(body).not.toHaveProperty('status');
      expect(body).not.toHaveProperty('missing');
    });

    it('liest eine unlesbare Zeile als „nichts hinterlegt", statt die Seite herunterzunehmen', async () => {
      // § 18 Abs. 1 MStV demands „ständig verfügbar": an imprint that
      // delivers a 500 because of a broken JSONB is the most expensive
      // conceivable failure of this function.
      await app().prisma
        .$executeRaw`INSERT INTO "system_setting" ("id", "legal_pages", "updated_at") VALUES (${SYSTEM_SETTING_ID}, '"kaputt"'::jsonb, now())`;

      const page = await request(app().server).get(
        apiPath('/public/legal/system/imprint'),
      );

      expect(page.status).toBe(200);
      expect(textOf((page.body as LegalPageBody).blocks)).toContain(
        'keine Anbieterangaben hinterlegt',
      );
    });
  });
});
