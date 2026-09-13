import request from 'supertest';
import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  EMPTY_LEGAL_DOCUMENT,
  LEGAL_FILL_MAX,
  LEGAL_LINK_MAX,
  LEGAL_TEXT_MAX,
  SYSTEM_LEGAL_TEMPLATES,
  TENANT_LEGAL_TEMPLATES,
  systemLegalPagesSchema,
  updateTenantLegalRequestSchema,
  type LegalDocument,
  type LegalTemplate,
} from '@formsache/shared';

import { Prisma } from '@prisma/client';

import type { SystemLegalResponse } from '../../src/system-settings/system-settings-wire';
import {
  JSON_BODY_LIMIT_BYTES,
  SYSTEM_LEGAL_BODY_LIMIT_BYTES,
  TENANT_LEGAL_BODY_LIMIT_BYTES,
} from '../../src/app-setup';
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
 * **The two legal-text writes have a payload limit of their own** — and
 * everything else keeps the 100 KiB (ADR-0028 no. 7).
 *
 * One `PUT` carries the whole document: two pages for an organisation, three
 * for the installation. Filled to the brim it is larger than
 * `JSON_BODY_LIMIT_BYTES`, and the body parser sits in front of every
 * controller — so what came back was a **413 without a field name** for a text
 * somebody had just spent an afternoon writing. The answer was not smaller
 * fields but a limit for exactly these two addresses
 * (`app-setup.ts`, `LEGAL_WRITE_BODY_LIMITS`), and that is what this file
 * measures.
 *
 * ## The calculation, and why it lives in the test as well
 *
 * {@link worstCase} rebuilds the largest payload the interface can produce
 * **out of the templates** rather than from a copied number: every placeholder
 * a template declares at `LEGAL_FILL_MAX`, every condition answered, every own
 * text at `LEGAL_TEXT_MAX`, and every character a three-byte one — the most
 * expensive kind, because the schema counts UTF-16 code units and the limiter
 * counts bytes (an emoji spends four bytes over two units and is therefore
 * *cheaper* per unit).
 *
 * Measured on 2026-08-20: **264 869 B** for the organisation's two pages and
 * **626 554 B** for the installation's three. Whoever adds a placeholder to a
 * template moves those numbers, and the two assertions in {@link fits} turn red
 * before a user ever meets the 413 — which is the whole reason the payload is
 * computed here instead of pasted.
 *
 * ## The three directions
 *
 * 1. the largest valid payload is **accepted** and stored,
 * 2. a payload past the *new* limit is still a **413** — the boundary moved, it
 *    did not go away,
 * 3. and the one that matters: a payload inside the new window with **one
 *    field** over its limit gets the **400 with a field path**. Before this
 *    change that same request was a 413, and that is what the exercise was for.
 */

const PASSWORD = 'test-password';
const TENANT_LEGAL = apiPath('/tenant/legal');
const SYSTEM_LEGAL = apiPath('/admin/system-settings/legal');

/**
 * **Was die Systemroute zurückgibt** — und ausdrücklich nicht dasselbe wie das,
 * was sie annimmt.
 *
 * Hier stand bis zur Review-Runde 5 `updateSystemLegalRequestSchema`, das
 * Schema der *Anfrage*, als Behelf. Seit `aiActive` mit der Antwort reist
 * (Befund Nr. 2: ohne diesen Wahrheitswert nahm die Karte die KI-Funktion als
 * abwesend an und ließ die sieben Felder des KI-Abschnitts weg), ist das ein
 * `unrecognized_keys` — zu Recht, denn ein Anfrageschema ist kein
 * Antwortvertrag. Dass der Wert dabei ist, wird hier gleich mitgemessen: seine
 * Rückkehr auf `false`-durch-Weglassen wäre genau der alte Fehler.
 *
 * Die Organisationsroute braucht kein Gegenstück — sie hat den Wert nicht und
 * kann ihn nicht haben, die KI-Einstellungen sind Systemeinstellungen.
 */
const systemLegalResponseSchema = z.object({
  pages: systemLegalPagesSchema,
  lock: z.number().int().positive(),
  aiActive: z.boolean(),
}) satisfies z.ZodType<SystemLegalResponse>;

/**
 * One UTF-16 code unit, three bytes in UTF-8 — the worst exchange rate between
 * what the field limits count and what the body limiter counts. An em dash and
 * German quotation marks are the everyday version of it, CJK the wholesale one.
 */
const WIDE_CHARACTER = '—';

/** A page filled to every one of its limits, in the widest characters. */
function worstCaseDocument(template: LegalTemplate): LegalDocument {
  return {
    // `custom`, because that is the mode in which the own text counts too — and
    // `fills` stays beside it either way (ADR-0028 §3), so both halves travel.
    mode: 'custom',
    fills: Object.fromEntries(
      template.slots.map((slot) => [
        slot.key,
        WIDE_CHARACTER.repeat(LEGAL_FILL_MAX),
      ]),
    ),
    conditions: Object.fromEntries(
      template.conditions.map((condition) => [condition.key, true]),
    ),
    custom: WIDE_CHARACTER.repeat(LEGAL_TEXT_MAX),
    /*
      **Der Verweis zählt mit, und er ist absichtlich schmal** (Review-Runde 5,
      Nachtrag). Er muss eine Adresse sein, die der Schreibweg annimmt — also
      ASCII, also ein Byte je Zeichen statt drei. Teurer kann er nicht werden:
      die Obergrenze zählt die **Eingabe**, und gespeichert wird die Eingabe
      (normalisiert wird erst beim Ausliefern).
    */
    link: `https://beispiel.invalid/${'a'.repeat(LEGAL_LINK_MAX - 30)}`,
  };
}

/** The largest payload the interface can produce for one of the two routes. */
function worstCase(
  templates: Readonly<Record<string, LegalTemplate>>,
): Record<string, unknown> {
  return {
    pages: Object.fromEntries(
      Object.entries(templates).map(([page, template]) => [
        page,
        worstCaseDocument(template),
      ]),
    ),
    lock: 1,
  };
}

/** What the body of a payload weighs on the wire — supertest sends this. */
function bytesOf(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

/**
 * The two statements that keep the limit honest, asserted before the request
 * so that a stale number fails with the size in the message.
 *
 * The lower bound is not decoration: without it a limit accidentally lowered
 * back to the general one would keep the „is accepted" case green, because the
 * payload would simply have shrunk with the templates.
 */
function fits(payload: unknown, limit: number): number {
  const size = bytesOf(payload);
  expect(
    size,
    'Die größte gültige Nutzlast passt nicht mehr in die Grenze dieser Route',
  ).toBeLessThanOrEqual(limit);
  expect(
    size,
    'Diese Route bräuchte gar keine eigene Grenze mehr',
  ).toBeGreaterThan(JSON_BODY_LIMIT_BYTES);
  return size;
}

describe('die eigene Körpergrenze der Rechtstext-Routen', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let alpha: TenantFixture;
  let superadmin: string;
  let tenantAdmin: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'LEGB');

    const root = await createUser(testApp.prisma, {
      email: 'grenze-root@example.org',
      password: PASSWORD,
      isSuperadmin: true,
    });
    superadmin = await openSession(testApp, root.id, alpha.id);

    const admin = await createUser(testApp.prisma, {
      email: 'grenze-admin@example.org',
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

  /** Nothing was written — the check every refusal in this file ends with. */
  async function tenantIsUntouched(): Promise<void> {
    const row = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: alpha.id },
      select: { legalPages: true, legalRevision: true },
    });
    expect(row.legalPages).toBeNull();
    expect(row.legalRevision).toBe(1);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // The organisation — two pages, 320 KiB
  // ═════════════════════════════════════════════════════════════════════════

  describe('bei der Organisation', () => {
    it('nimmt die größte gültige Nutzlast an', async () => {
      const payload = worstCase(TENANT_LEGAL_TEMPLATES);
      fits(payload, TENANT_LEGAL_BODY_LIMIT_BYTES);

      const response = await request(app().server)
        .put(TENANT_LEGAL)
        .set(authedMutation(tenantAdmin))
        .send(payload);

      expect(response.status).toBe(200);
      // Not merely „not a 413": the document went through the schema, into the
      // column and back out at its full length. Read through the shared schema
      // rather than cast into shape — the answer of a write carries the same
      // `{ pages, lock }` as its request, and a response that drifted from it
      // fails here instead of being asserted against blindly.
      const written = updateTenantLegalRequestSchema.parse(response.body);
      expect(written.pages.privacy.custom).toHaveLength(LEGAL_TEXT_MAX);
      expect(written.pages.imprint.fills.PLZ).toHaveLength(LEGAL_FILL_MAX);
      expect(written.lock).toBe(2);
    }, 60_000);

    it('weist eine Nutzlast über der neuen Grenze weiterhin mit 413 ab', async () => {
      // Past the new limit by a wide margin, and deliberately in ASCII: the
      // limiter counts bytes, so nothing about this depends on the encoding.
      const payload = {
        ...worstCase(TENANT_LEGAL_TEMPLATES),
        pages: {
          imprint: {
            ...worstCaseDocument(TENANT_LEGAL_TEMPLATES.imprint),
            custom: 'x'.repeat(TENANT_LEGAL_BODY_LIMIT_BYTES),
          },
          privacy: worstCaseDocument(TENANT_LEGAL_TEMPLATES.privacy),
        },
      };
      expect(bytesOf(payload)).toBeGreaterThan(TENANT_LEGAL_BODY_LIMIT_BYTES);

      const response = await request(app().server)
        .put(TENANT_LEGAL)
        .set(authedMutation(tenantAdmin))
        .send(payload);

      expect(response.status).toBe(413);
      await tenantIsUntouched();
    }, 60_000);

    it('bleibt bei einem einzelnen zu langen Feld die 400 mit Feldpfad — und wird keine 413', async () => {
      // One single character over `LEGAL_FILL_MAX`, in a payload that stays
      // inside the new window — and would have been a 413 before it existed.
      const privacy = worstCaseDocument(TENANT_LEGAL_TEMPLATES.privacy);
      const payload = {
        ...worstCase(TENANT_LEGAL_TEMPLATES),
        pages: {
          imprint: worstCaseDocument(TENANT_LEGAL_TEMPLATES.imprint),
          privacy: {
            ...privacy,
            fills: {
              ...privacy.fills,
              STAND: WIDE_CHARACTER.repeat(LEGAL_FILL_MAX + 1),
            },
          },
        },
      };
      fits(payload, TENANT_LEGAL_BODY_LIMIT_BYTES);

      const response = await request(app().server)
        .put(TENANT_LEGAL)
        .set(authedMutation(tenantAdmin))
        .send(payload);

      expect(validationPaths(response.status, response.body)).toEqual([
        'pages.privacy.fills.STAND',
      ]);
      await tenantIsUntouched();
    }, 60_000);

    /**
     * The content type is checked in the predicate as well, and this is why: a
     * parser that read `text/plain` would make these two routes reachable for
     * an HTML form and reopen the hole `APP_OPTIONS.bodyParser` closes.
     */
    it('liest auch hier keinen text/plain-Körper', async () => {
      const response = await request(app().server)
        .put(TENANT_LEGAL)
        .set(authedMutation(tenantAdmin))
        .set('Content-Type', 'text/plain')
        .send(
          JSON.stringify({
            pages: {
              imprint: { ...EMPTY_LEGAL_DOCUMENT, custom: 'Kurz.' },
              privacy: EMPTY_LEGAL_DOCUMENT,
            },
            lock: 1,
          }),
        );

      expect(response.status).toBe(400);
      await tenantIsUntouched();
    });

    /**
     * The method half of the predicate. `POST` is no route of this controller,
     * so what is measured here is the *parser*: it refuses at 100 KiB and
     * therefore never let the larger limit apply to anything but the write.
     */
    it('gilt nur für den Schreibvorgang und nicht für jede Methode', async () => {
      const between = Math.floor(
        (JSON_BODY_LIMIT_BYTES + TENANT_LEGAL_BODY_LIMIT_BYTES) / 2,
      );

      const response = await request(app().server)
        .post(TENANT_LEGAL)
        .set(authedMutation(tenantAdmin))
        .send({ filler: 'x'.repeat(between) });

      expect(response.status).toBe(413);
    });

    /**
     * The three spellings `pathOf` normalises — each one measured against the
     * server rather than assumed, because each one reaches the controller: a
     * trailing slash, an upper-case path and a query string. `/tenant/legal//`
     * is deliberately not among them; Express answers it with a 404, and the
     * parser must not read 320 KiB for an address that does not exist.
     */
    it('erkennt die Adresse auch mit Schrägstrich, in Großschreibung und mit Abfrageteil', async () => {
      const variants = [
        `${TENANT_LEGAL}/`,
        TENANT_LEGAL.toUpperCase(),
        `${TENANT_LEGAL}?entwurf=1`,
      ];

      let lock = 1;
      for (const variant of variants) {
        const payload = { ...worstCase(TENANT_LEGAL_TEMPLATES), lock };
        fits(payload, TENANT_LEGAL_BODY_LIMIT_BYTES);

        const response = await request(app().server)
          .put(variant)
          .set(authedMutation(tenantAdmin))
          .send(payload);

        // Not `not.toBe(413)`: a 200 says the body was read *and* the request
        // arrived where it belongs.
        expect(response.status, `Adresse: ${variant}`).toBe(200);
        lock += 1;
      }
    }, 60_000);

    /**
     * And the spelling that stops one short: `/tenant/legal//` is a **404** —
     * Express does not route it. So the parser answers it at the general limit
     * instead of reading a quarter of a megabyte for an address that leads
     * nowhere. Replace `pathOf`'s `/\/$/` with `/\/+$/` and this turns red.
     */
    it('liest den doppelten Schrägstrich nicht groß — er ist gar keine Adresse', async () => {
      const payload = worstCase(TENANT_LEGAL_TEMPLATES);
      fits(payload, TENANT_LEGAL_BODY_LIMIT_BYTES);

      const response = await request(app().server)
        .put(`${TENANT_LEGAL}//`)
        .set(authedMutation(tenantAdmin))
        .send(payload);

      expect(response.status).toBe(413);
      await tenantIsUntouched();
    }, 60_000);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The installation — three pages, 768 KiB
  // ═════════════════════════════════════════════════════════════════════════

  describe('bei der Installation', () => {
    it('nimmt die größte gültige Nutzlast an', async () => {
      const payload = worstCase(SYSTEM_LEGAL_TEMPLATES);
      fits(payload, SYSTEM_LEGAL_BODY_LIMIT_BYTES);

      const response = await request(app().server)
        .put(SYSTEM_LEGAL)
        .set(authedMutation(superadmin))
        .send(payload);

      expect(response.status).toBe(200);
      const written = systemLegalResponseSchema.parse(response.body);
      expect(written.pages.privacy.custom).toHaveLength(LEGAL_TEXT_MAX);
      expect(written.lock).toBe(2);
    }, 60_000);

    it('weist eine Nutzlast über der neuen Grenze weiterhin mit 413 ab', async () => {
      const payload = {
        ...worstCase(SYSTEM_LEGAL_TEMPLATES),
        pages: {
          imprint: {
            ...worstCaseDocument(SYSTEM_LEGAL_TEMPLATES.imprint),
            custom: 'x'.repeat(SYSTEM_LEGAL_BODY_LIMIT_BYTES),
          },
          privacy: worstCaseDocument(SYSTEM_LEGAL_TEMPLATES.privacy),
        },
      };
      expect(bytesOf(payload)).toBeGreaterThan(SYSTEM_LEGAL_BODY_LIMIT_BYTES);

      const response = await request(app().server)
        .put(SYSTEM_LEGAL)
        .set(authedMutation(superadmin))
        .send(payload);

      expect(response.status).toBe(413);
      expect(await app().prisma.systemSetting.count()).toBe(0);
    }, 60_000);

    it('bleibt bei einem einzelnen zu langen Feld die 400 mit Feldpfad — und wird keine 413', async () => {
      const payload = {
        ...worstCase(SYSTEM_LEGAL_TEMPLATES),
        pages: {
          imprint: worstCaseDocument(SYSTEM_LEGAL_TEMPLATES.imprint),
          privacy: {
            ...worstCaseDocument(SYSTEM_LEGAL_TEMPLATES.privacy),
            custom: WIDE_CHARACTER.repeat(LEGAL_TEXT_MAX + 1),
          },
        },
      };
      fits(payload, SYSTEM_LEGAL_BODY_LIMIT_BYTES);

      const response = await request(app().server)
        .put(SYSTEM_LEGAL)
        .set(authedMutation(superadmin))
        .send(payload);

      expect(validationPaths(response.status, response.body)).toEqual([
        'pages.privacy.custom',
      ]);
      expect(await app().prisma.systemSetting.count()).toBe(0);
    }, 60_000);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // And everything else keeps the 100 KiB — that is the decision
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * The counter-example without which the three above prove nothing about the
   * *scope* of the change: a body of the same size that these routes now read
   * has to stay a 413 anywhere else. Whoever raises the general limit instead
   * turns this one red.
   */
  it('lässt die 100 KiB für jede andere Route stehen', async () => {
    const oversized = 'x'.repeat(
      JSON_BODY_LIMIT_BYTES +
        (TENANT_LEGAL_BODY_LIMIT_BYTES - JSON_BODY_LIMIT_BYTES) / 2,
    );
    expect(oversized.length).toBeLessThan(TENANT_LEGAL_BODY_LIMIT_BYTES);

    const response = await request(app().server)
      .post(apiPath('/auth/login'))
      .send({ email: 'grenze-admin@example.org', password: oversized });

    expect(response.status).toBe(413);
  });
});
