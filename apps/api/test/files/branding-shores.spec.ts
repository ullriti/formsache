import { randomBytes } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
import { cookieHeader, openSession } from '../support/http';

/**
 * **The four shores of the Logo gate** (ADR-0014
 * no. 12).
 *
 * `deliverableBranding()` cannot answer „gehört diese Datei dieser Organisation?" — it
 * is pure, it has no database, and both values it could compare come out of one
 * row. So the ownership is the *query's*: each of the four reading paths loads
 * the organisation's own `tenant_logo` files through the tenant relation, and the gate
 * only confirms what the relation returned. ADR-0014 no. 12 names all four, and
 * a gate that held at one of them would be a gate beside the door:
 *
 * 1. `GET /api/public/forms/:slug` — the **sessionless** fill-in page, and the
 *    load-bearing one: there is no signed-in Organisation here to compare against;
 * 2. `GET /api/auth/me` — the session payload;
 * 3. `GET /api/tenant/branding` — the *Erscheinungsbild* tab;
 * 4. `GET /api/admin/tenants` — the superadmin overview, **across** Organisationen, with
 *    the relation loaded per row rather than resolved once for the viewer.
 *
 * ## What this suite measures
 *
 * Now the wire carries the union itself (`tenantLogoSchema`), so
 * „owned" and „foreign" are finally distinguishable from the outside — and that
 * is the difference this file now measures rather than describes: the organisation's
 * **own** upload leaves as `{"kind":"upload"}`, another organisation's leaves as
 * `null`, at all four shores. Before that, both were `null`, because the wire
 * narrowed everything to the shipped assets and the assertion could not tell
 * a working gate from an absent arm.
 *
 * *Reproductions, run and **measured** — the numbers, not the intentions:*
 * - bypass the gate at the four shores (`logoRef` built from `tenant.logoRef`
 *   instead of from `deliverableBranding(tenant, ownedLogoRef(tenant))`) →
 *   **five** cases go red, including „another organisation's upload reference" at all
 *   four shores and every poisoned value. That is the measurement that says the
 *   gate, and not a coincidence, holds these four shores;
 * - drop the `ownedUpload` argument only (`deliverableBranding(tenant)`) →
 *   **one** case goes red, „this organisation's own upload", and none of the refusals.
 *   That is the ADR's own claim measured: a shore that forgets the relation
 *   loses the Logo and never hands out a foreign one.
 */

const definition = {
  pages: [
    {
      id: '019ff600-0000-7000-8000-0000000000a0',
      title: 'Seite',
      questions: [],
    },
  ],
};

/** A reference of the shape the upload mints — 16 bytes, base64url. */
function ref(): string {
  return randomBytes(16).toString('base64url');
}

describe('the four shores of the Logo gate ', () => {
  let database: TestDatabase;
  let testApp: TestApp;

  let own: TenantFixture;
  let other: TenantFixture;
  let slug: string;
  let editor: string;
  let superadmin: string;

  /** `own`'s own Logo file, and one that belongs to the other organisation. */
  let ownUpload: string;
  let foreignUpload: string;

  const prisma = (): TestApp['prisma'] => testApp.prisma;

  async function plantLogo(tenantId: string): Promise<string> {
    const publicRef = ref();
    await prisma().file.create({
      data: {
        tenantId,
        kind: 'tenant_logo',
        publicRef,
        fileName: 'logo.png',
        contentType: 'image/png',
        status: 'stored',
      },
    });
    return publicRef;
  }

  /** Writes the column past every schema — the precondition only a gate meets. */
  async function poison(logoRef: string): Promise<void> {
    await prisma().$executeRawUnsafe(
      'UPDATE "tenant" SET "logo_ref" = $1 WHERE "id" = $2::uuid',
      logoRef,
      own.id,
    );
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    own = await createTenant(prisma(), 'SHORES');
    other = await createTenant(prisma(), 'SHORESB');

    ownUpload = await plantLogo(own.id);
    foreignUpload = await plantLogo(other.id);

    slug = randomBytes(16).toString('base64url');
    const form = await prisma().form.create({
      data: {
        tenantId: own.id,
        title: 'Anmeldung',
        draftSchema: definition,
        publicSlug: slug,
        status: 'active',
      },
      select: { id: true },
    });
    const version = await prisma().formVersion.create({
      data: {
        tenantId: own.id,
        formId: form.id,
        version: 1,
        schema: definition,
      },
      select: { id: true },
    });
    await prisma().form.update({
      where: { id: form.id },
      data: { publishedVersionId: version.id },
    });

    const user = await createUser(prisma(), {
      email: 'shores@example.org',
      password: 'test-password',
      tenants: [own],
    });
    editor = await openSession(testApp, user.id, own.id);

    const root = await createUser(prisma(), {
      email: 'root@example.org',
      password: 'test-password',
      tenants: [own],
      isSuperadmin: true,
    });
    superadmin = await openSession(testApp, root.id, own.id);
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database.release();
  }, 120_000);

  /** The four payloads, in the order ADR-0014 no. 12 names them. */
  async function shores(): Promise<
    { readonly name: string; readonly body: string; readonly status: number }[]
  > {
    const publicPage = await request(testApp.server).get(
      apiPath(`/public/forms/${slug}`),
    );
    const session = await request(testApp.server)
      .get(apiPath('/auth/me'))
      .set('Cookie', cookieHeader(editor));
    const tab = await request(testApp.server)
      .get(apiPath('/tenant/branding'))
      .set('Cookie', cookieHeader(editor));
    const overview = await request(testApp.server)
      .get(apiPath('/admin/tenants'))
      .set('Cookie', cookieHeader(superadmin));

    return [
      { name: 'public fill-in page', ...pick(publicPage) },
      { name: 'session payload', ...pick(session) },
      { name: 'Erscheinungsbild tab', ...pick(tab) },
      { name: 'superadmin overview', ...pick(overview) },
    ];
  }

  function pick(response: request.Response): {
    readonly body: string;
    readonly status: number;
  } {
    return { body: response.text, status: response.status };
  }

  it('all four answer at all — a 404 would make every assertion vacuous', async () => {
    // The trap in the base case („gebaut ist nicht erreichbar"): a shore that
    // answers 404 contains no reference either, and would pass every test below
    // while proving nothing.
    for (const shore of await shores()) {
      expect(shore.status, shore.name).toBe(200);
      expect(shore.body, shore.name).toContain('logoRef');
    }
  });

  /**
   * **What proves the requirement at the wire level** — the rendered half is
   * `apps/web/src/views/PublicFormView.test.tsx`, because the requirement asks for the page
   * and not for the field.
   */
  it('delivers this organisation’s own upload reference at all four shores', async () => {
    await poison(ownUpload);

    for (const shore of await shores()) {
      expect(shore.body, shore.name).toContain(
        `{"kind":"upload","ref":"${ownUpload}"}`,
      );
    }
  });

  /**
   * **The case the requirement is about.** The column names a file of *another*
   * Organisation — through a raw write, an older version, a restore — and the
   * tenant-bound relation therefore proves nothing. What must not happen is
   * that the reference travels anyway, least of all on the public page, where
   * there is no session against which anybody could have compared it.
   */
  it('delivers another organisation’s upload reference at none of the four shores', async () => {
    await poison(foreignUpload);

    for (const shore of await shores()) {
      expect(shore.body, shore.name).not.toContain(foreignUpload);
      expect(shore.body, shore.name).toContain('"logoRef":null');
    }
  });

  it.each([
    'javascript:alert(1)',
    'https://fremd.example/logo.png',
    '//fremd.example/logo.png',
    'assets/../../etc/passwd',
  ])(
    'delivers the poisoned Logo %s at none of the four shores',
    async (value) => {
      await poison(value);

      for (const shore of await shores()) {
        expect(shore.body, shore.name).not.toContain('fremd.example');
        expect(shore.body, shore.name).not.toContain('javascript:');
        expect(shore.body, shore.name).toContain('"logoRef":null');
      }
    },
  );

  it('still delivers a shipped Logo at all four shores', async () => {
    // The counter-check: without it every assertion above would pass on a gate
    // that answers `null` to everything, and the Organisationen would silently lose
    // their Logo.
    await poison('assets/beispiel-emblem.svg');

    for (const shore of await shores()) {
      expect(shore.body, shore.name).toContain(
        '{"kind":"asset","ref":"assets/beispiel-emblem.svg"}',
      );
    }
  });
});
