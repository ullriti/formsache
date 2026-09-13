import { Prisma } from '@prisma/client';
import { EMPTY_LEGAL_DOCUMENT, type LegalDocument } from '@formsache/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MISSING_PERMISSION_MESSAGE } from '../../src/tenancy/group-permission.guard';
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
 * **The traffic light for the organisation's legal texts in the
 * Veröffentlichen-Dialog** (ADR-0028, open item 3) —
 * `publishPreviewSchema.organisationLegal`.
 *
 * The open item was: the hint before publishing does not reach everybody.
 * `GET /tenant/legal` demands `can_manage_settings`; an editor holding
 * `can_build` alone — the very permission that publishes — never learns that
 * her organisation has neither provider details nor privacy notices. The
 * field closes that, and it does so on a route she is already allowed:
 * `GET /forms/:id/publish-preview`.
 *
 * Three promises, and only an integration test can keep them, because all
 * three are about a guard chain, a second organisation's row and a payload
 * that leaves the server:
 *
 * 1. **The case that must fail** (`AGENTS.md`): the same editor gets from
 *    this route **nothing beyond the traffic light** — not the text, not a
 *    field name, not which of the two pages — and `GET /tenant/legal` keeps
 *    refusing her. A test that only saw the light would prove that something
 *    is answered, not that the guard on the document still holds.
 * 2. **The case that must carry**: she does see the light, and it is right —
 *    incomplete stays away from `ready`, complete reaches it, and the worse
 *    of the two pages wins.
 * 3. **Tenant isolation**: the light reads the legal texts of **the
 *    organisation of this form** and never those of another. Measured in the
 *    one arrangement in which a mix-up would be visible — the two
 *    organisations hold *opposite* states at the same moment, so a swapped
 *    row shows up as the opposite verdict rather than as a coincidence.
 *
 * **Reproduction, measured while writing** (each step run, each result read
 * off):
 *
 * - Let `tenantLegalStatus` (`apps/api/src/forms/forms.service.ts`) return the
 *   first of the two verdicts instead of folding them — „nimmt den schlechteren
 *   der beiden Zustände" goes red **and nothing else** (1 failed, 4 passed).
 * - Let the same function answer `'ready'` unconditionally — three cases go
 *   red: the shortcoming, the fold and the tenant isolation. The two that stay
 *   green are the ones about the *guard*, which is the right split: a light
 *   that lies is not a light that leaks.
 * - Widen the field to one verdict per page, in the schema **and** in the
 *   service — all five go red, the first of them at „die Antwort ist **ein**
 *   Wert". That is the shape assertion doing the work; `not.toContain('imprint')`
 *   below it is the second net, for a leak that keeps the shape.
 *
 * ⚠️ **The tenant mix-up of no. 3 cannot be written down in the service at
 * all** and was therefore not reproduced by breaking it: `FormsService` holds
 * no `PrismaService`, and `ScopedTenantDelegate` takes no tenant as an
 * argument (`tenancy/tenant-scope.ts`). The case measures the outcome
 * regardless, because that structure is a decision somebody can undo — a
 * tenant id handed in as a parameter would compile.
 */

const PASSWORD = 'test-password';
const TENANT_LEGAL = apiPath('/tenant/legal');

/** Own text without an open placeholder — `ready` by the shortest route. */
function ownText(text: string): LegalDocument {
  return { ...EMPTY_LEGAL_DOCUMENT, mode: 'custom', custom: text };
}

/**
 * Own text **with** an open placeholder — `incomplete`.
 *
 * ADR-0028 §4: a text with a remaining `[[PLATZHALTER]]` counts as finished
 * nowhere, and this dialogue is one of the places where that has to hold.
 */
function startedText(): LegalDocument {
  return ownText('Anbieter: [[NAME]] in Musterstadt.');
}

interface PreviewBody {
  readonly organisationLegal: string;
  readonly privacyNotice: string;
}

describe('die Rechtstexte der Organisation im Veröffentlichen-Dialog', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let alpha: TenantFixture;
  let beta: TenantFixture;

  /** Administrator in alpha — writes the legal texts and builds the forms. */
  let alphaAdmin: string;
  /**
   * The person the open item is about: she builds and publishes in alpha and
   * may **not** manage the settings.
   *
   * ⚠️ **The trap sits in the fixture, not in the code.** She holds *every
   * other* permission — `can_manage_form_settings` included, which is the one
   * that writes a form's own notice. Somebody holding nothing would only
   * prove that *some* guard fires (`AGENTS.md`).
   */
  let builderWithoutSettings: string;
  /** Administrator in **beta** — the second organisation of promise 3. */
  let betaAdmin: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'OLPA');
    beta = await createTenant(testApp.prisma, 'OLPB');

    const admin = await createUser(testApp.prisma, {
      email: 'olp-alpha@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    alphaAdmin = await openSession(testApp, admin.id, alpha.id);

    const other = await createUser(testApp.prisma, {
      email: 'olp-beta@example.org',
      password: PASSWORD,
      tenants: [beta],
    });
    betaAdmin = await openSession(testApp, other.id, beta.id);

    const restricted = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'olp-ohne-einstellungen@example.org',
      groupName: 'Baut, verwaltet aber nicht',
      permissions: {
        canBuild: true,
        canViewResponses: true,
        canExport: true,
        canManageSettings: false,
        canManageFormSettings: true,
        canManageUsers: true,
      },
    });
    builderWithoutSettings = await openSession(
      testApp,
      restricted.id,
      alpha.id,
    );
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  afterEach(async () => {
    await app().prisma.tenant.updateMany({
      // `Prisma.DbNull` and not `null`: on a JSON column `null` would be
      // ambiguous (JSON `null` against SQL NULL), and this application writes
      // exclusively SQL NULL for „nichts hinterlegt".
      data: { legalPages: Prisma.DbNull, legalRevision: 1 },
    });
  });

  /** A form of the organisation the token belongs to — a draft is enough. */
  async function createForm(token: string, title: string): Promise<string> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(token))
      .send({ title });
    expect(created.status).toBe(201);
    return (created.body as { id: string }).id;
  }

  /** Writes both legal texts through the real route, with the current lock. */
  async function writeLegal(
    token: string,
    tenantId: string,
    pages: { imprint: LegalDocument; privacy: LegalDocument },
  ): Promise<void> {
    const row = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { legalRevision: true },
    });
    const written = await request(app().server)
      .put(TENANT_LEGAL)
      .set(authedMutation(token))
      .send({ pages, lock: row.legalRevision });
    expect(written.status).toBe(200);
  }

  function preview(token: string, formId: string): request.Test {
    return request(app().server)
      .get(apiPath(`/forms/${formId}/publish-preview`))
      .set('Cookie', cookieHeader(token));
  }

  async function statusOf(token: string, formId: string): Promise<string> {
    const response = await preview(token, formId);
    expect(response.status).toBe(200);
    return (response.body as PreviewBody).organisationLegal;
  }

  describe('was die Bearbeiterin ohne „Einstellungen verwalten" bekommt', () => {
    /**
     * **The case that must fail, in both halves.** The traffic light must not
     * become the way around the guard: the answer says „ready" and gives away
     * nothing that stands behind `can_manage_settings` — and that route keeps
     * refusing the same person in the same breath.
     */
    it('bekommt die Ampel, aber weder Text noch Feld noch Seite — und /tenant/legal weist sie weiter ab', async () => {
      const formId = await createForm(alphaAdmin, 'Jahrestagung');
      await writeLegal(alphaAdmin, alpha.id, {
        imprint: ownText('Anbieter ist der Musterverein in Musterstadt.'),
        privacy: ownText('Verantwortlich ist der Musterverein.'),
      });

      const response = await preview(builderWithoutSettings, formId);
      expect(response.status).toBe(200);
      expect((response.body as PreviewBody).organisationLegal).toBe('ready');

      // A traffic light and nothing structured: neither the text of the two
      // pages, nor the shape of the document behind them (`mode`, `fills`,
      // `custom`), nor the name of a page. „Welche der beiden Seiten" is the
      // first step of the detour, and it is refused here rather than
      // discussed.
      expect(response.text).not.toContain('Musterverein');
      expect(response.text).not.toContain('Musterstadt');
      expect(response.text).not.toContain('imprint');
      expect(response.text).not.toContain('fills');
      expect(response.text).not.toContain('custom');

      // And the document itself is as unreachable for her as it was before.
      const refused = await request(app().server)
        .get(TENANT_LEGAL)
        .set('Cookie', cookieHeader(builderWithoutSettings));
      expect(refused.status).toBe(403);
      expect(refused.text).toContain(MISSING_PERMISSION_MESSAGE);
    });

    /**
     * The half of the promise that has to **carry**: without the field she
     * would learn nothing at all, which is exactly the open item.
     */
    it('sieht den Mangel, solange nichts hinterlegt ist', async () => {
      const formId = await createForm(alphaAdmin, 'Ohne Rechtstexte');

      expect(await statusOf(builderWithoutSettings, formId)).toBe('empty');
    });
  });

  describe('die Ampel selbst', () => {
    it('sagt `ready`, wenn beide Seiten stehen', async () => {
      const formId = await createForm(alphaAdmin, 'Beide Seiten');
      await writeLegal(alphaAdmin, alpha.id, {
        imprint: ownText('Anbieter ist der Musterverein.'),
        privacy: ownText('Verantwortlich ist der Musterverein.'),
      });

      expect(await statusOf(builderWithoutSettings, formId)).toBe('ready');
    });

    /**
     * **The worse state wins**, and both directions are measured:
     * a page with an open placeholder pulls the verdict down to `incomplete`,
     * a page with nothing at all down to `empty`. One light for two pages is
     * only honest if it takes the worse one — a `ready` next to an empty
     * imprint would be the quiet variant of the very defect this field is
     * built against.
     */
    it('nimmt den schlechteren der beiden Zustände', async () => {
      const formId = await createForm(alphaAdmin, 'Schlechtester gewinnt');

      await writeLegal(alphaAdmin, alpha.id, {
        imprint: ownText('Anbieter ist der Musterverein.'),
        privacy: startedText(),
      });
      expect(await statusOf(builderWithoutSettings, formId)).toBe('incomplete');

      await writeLegal(alphaAdmin, alpha.id, {
        imprint: ownText('Anbieter ist der Musterverein.'),
        privacy: EMPTY_LEGAL_DOCUMENT,
      });
      expect(await statusOf(builderWithoutSettings, formId)).toBe('empty');

      // And the other way round, so that the fold is not read off one page:
      // the same two verdicts with the roles of the pages exchanged.
      await writeLegal(alphaAdmin, alpha.id, {
        imprint: startedText(),
        privacy: ownText('Verantwortlich ist der Musterverein.'),
      });
      expect(await statusOf(builderWithoutSettings, formId)).toBe('incomplete');

      await writeLegal(alphaAdmin, alpha.id, {
        imprint: EMPTY_LEGAL_DOCUMENT,
        privacy: ownText('Verantwortlich ist der Musterverein.'),
      });
      expect(await statusOf(builderWithoutSettings, formId)).toBe('empty');
    });
  });

  /**
   * **The legal texts of *this* form's organisation** — never those of
   * another.
   *
   * The two organisations hold opposite states at the same moment, and each
   * form is asked with the session of its own organisation. A read that took
   * the wrong row would therefore not answer „auch richtig" by chance; it
   * would answer the exact opposite.
   */
  describe('Mandantentrennung', () => {
    it('liest die Rechtstexte der Organisation des Formulars und nie die einer anderen', async () => {
      const alphaForm = await createForm(alphaAdmin, 'Alpha');
      const betaForm = await createForm(betaAdmin, 'Beta');

      // Beta is complete, alpha has nothing.
      await writeLegal(betaAdmin, beta.id, {
        imprint: ownText('Anbieter ist der Beta-Verein.'),
        privacy: ownText('Verantwortlich ist der Beta-Verein.'),
      });

      expect(await statusOf(builderWithoutSettings, alphaForm)).toBe('empty');
      expect(await statusOf(betaAdmin, betaForm)).toBe('ready');

      // Exchanged: now alpha is complete and beta has nothing.
      await app().prisma.tenant.updateMany({
        where: { id: beta.id },
        data: { legalPages: Prisma.DbNull, legalRevision: 1 },
      });
      await writeLegal(alphaAdmin, alpha.id, {
        imprint: ownText('Anbieter ist der Alpha-Verein.'),
        privacy: ownText('Verantwortlich ist der Alpha-Verein.'),
      });

      expect(await statusOf(builderWithoutSettings, alphaForm)).toBe('ready');
      expect(await statusOf(betaAdmin, betaForm)).toBe('empty');
    });
  });
});
