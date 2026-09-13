import { randomBytes } from 'node:crypto';

import { MAX_TENANT_LOGO_BYTES } from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MISSING_PERMISSION_MESSAGE } from '../../src/tenancy/group-permission.guard';
import { UNKNOWN_LOGO_MESSAGE } from '../../src/tenant-admin/tenant-branding.service';
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
import { InMemoryFileStorage } from '../support/in-memory-file-storage';

/**
 * **The logo upload beside the asset selection** — the requirement, the specification,
 * ADR-0014 no. 12 and no. 15, against real PostgreSQL and the storage double.
 *
 * What the requirement asks for, and where each half is measured:
 *
 * 1. „eine Organisation lädt sein Logo hoch; es erscheint auf der öffentlichen
 *    Ausfüllseite" — the **payload** half is here, the **rendered page** half is
 *    `apps/web/src/views/PublicFormView.test.tsx`, because the requirement says „gemessen an
 *    der gerenderten Seite, nicht am Wire-Feld" and a wire assertion alone
 *    cannot see a view that ignores the field;
 * 2. „`deliverableBranding()` bleibt die serverseitige Vertrauensgrenze, ein
 *    Verweis auf eine fremde Datei geht nicht hinaus" — the four-shore version
 *    lives in `test/files/branding-shores.spec.ts`; what this file adds is the
 *    **public** shore against a genuinely uploaded foreign file plus the
 *    counter-check that the same reference is delivered to *its own* Organisation;
 * 3. „die Auswahl aus den mitgelieferten Assets bleibt" — including the way
 *    back, which is where the uploaded file goes.
 *
 * ## The life cycle, which ADR-0014 no. 15 left to this package
 *
 * Decided here and built here: **an upload is a replacement**, so a
 * `tenant_logo` row exists only while `tenant.logo_ref` names it. The purge
 * touches no Logo (deliberately, no. 15), so anything else would be litter
 * nobody collects. The invariant is asserted after every operation below, and
 * it is the assertion that would go red if the sweep were dropped.
 *
 * *Reproductions, run and **measured** — see the report for the numbers.*
 */

const PASSWORD = 'test-password';

const definition = {
  pages: [
    {
      id: '019ff600-0000-7000-8000-0000000000b0',
      title: 'Seite',
      questions: [],
    },
  ],
};

/** A real PNG header plus filler — the content, which is all that is checked. */
function png(size = 64): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);
}

function pdf(size = 64): Buffer {
  const head = Buffer.from('%PDF-1.7\n');
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);
}

/** An SVG — on neither list, whatever it is called or declared to be. */
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);

interface Branding {
  logoRef: { kind: string; ref: string } | null;
  logoChoices: string[];
  revision: number;
  name: string;
  logoWide: boolean;
  stripeColors: string[];
  accent: string;
  headerBg: string;
  canvasBg: string;
  shortName: string;
}

describe('the Logo upload', () => {
  let database: TestDatabase;
  let testApp: TestApp;
  let storage: InMemoryFileStorage;

  let own: TenantFixture;
  let other: TenantFixture;
  let admin: string;
  let withoutSettings: string;
  let otherAdmin: string;
  /** A published form of `own` — the sessionless page under test. */
  let slug: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    storage = new InMemoryFileStorage();
    testApp = await createTestApp({ databaseUrl: database.url, storage });

    own = await createTenant(testApp.prisma, 'WAP');
    other = await createTenant(testApp.prisma, 'WAPB');

    slug = randomBytes(16).toString('base64url');
    const form = await testApp.prisma.form.create({
      data: {
        tenantId: own.id,
        title: 'Anmeldung',
        draftSchema: definition,
        publicSlug: slug,
        status: 'active',
      },
      select: { id: true },
    });
    const version = await testApp.prisma.formVersion.create({
      data: {
        tenantId: own.id,
        formId: form.id,
        version: 1,
        schema: definition,
      },
      select: { id: true },
    });
    await testApp.prisma.form.update({
      where: { id: form.id },
      data: { publishedVersionId: version.id },
    });

    const user = await createUser(testApp.prisma, {
      email: 'logo@example.org',
      password: PASSWORD,
      tenants: [own],
    });
    admin = await openSession(testApp, user.id, own.id);

    // Holds **all four other** permissions and only lacks `canManageSettings`:
    // a member with nothing at all would prove that *some* guard fires, which
    // is not the claim.
    const restricted = await createRestrictedMember(testApp.prisma, own, {
      email: 'logo-ohne-einstellungen@example.org',
      groupName: 'Ohne Einstellungen',
      permissions: {
        canBuild: true,
        canViewResponses: true,
        canExport: true,
        canManageSettings: false,
        canManageFormSettings: false,
        canManageUsers: true,
      },
    });
    withoutSettings = await openSession(testApp, restricted.id, own.id);

    const otherUser = await createUser(testApp.prisma, {
      email: 'logo-fremd@example.org',
      password: PASSWORD,
      tenants: [other],
    });
    otherAdmin = await openSession(testApp, otherUser.id, other.id);
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database.release();
  }, 120_000);

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function upload(
    session: string,
    body: Buffer,
    options: { fileName?: string; contentType?: string } = {},
  ): request.Test {
    return request(app().server)
      .post(apiPath('/tenant/branding/logo'))
      .set(authedMutation(session))
      .set('Content-Type', options.contentType ?? 'application/octet-stream')
      .set('X-File-Name', encodeURIComponent(options.fileName ?? 'logo.png'))
      .send(body);
  }

  async function readBranding(session: string): Promise<Branding> {
    const response = await request(app().server)
      .get(apiPath('/tenant/branding'))
      .set('Cookie', cookieHeader(session));
    expect(response.status).toBe(200);
    return response.body as Branding;
  }

  async function saveBranding(
    session: string,
    document: Branding,
    overrides: Partial<Branding>,
  ): Promise<request.Response> {
    // `shortName` and `logoChoices` are read-only fields of the document; the
    // write schema is a `strictObject` and refuses them.
    const rest = { ...document } as Partial<Branding>;
    delete rest.shortName;
    delete rest.logoChoices;
    return request(app().server)
      .put(apiPath('/tenant/branding'))
      .set(authedMutation(session))
      .send({ ...rest, ...overrides });
  }

  /** Every `tenant_logo` row of an organisation, newest last. */
  async function logoRows(
    tenant: TenantFixture,
  ): Promise<{ id: string; publicRef: string }[]> {
    return app().prisma.file.findMany({
      where: { tenantId: tenant.id, kind: 'tenant_logo' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, publicRef: true },
    });
  }

  /**
   * **The invariant this package decided** — a `tenant_logo` row exists only
   * while `tenant.logo_ref` names it, and its bytes exist only while the row
   * does.
   *
   * Asserted after every operation instead of only where a deletion is
   * expected: a sweep that ran once and stopped, or one that ran at the wrong
   * moment, is invisible to a test that only ever looks at the happy step.
   */
  async function expectInvariant(tenant: TenantFixture): Promise<void> {
    const row = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: tenant.id },
      select: { logoRef: true },
    });
    const rows = await logoRows(tenant);
    for (const file of rows) {
      expect(file.publicRef, 'an unreferenced tenant_logo survived').toBe(
        row.logoRef,
      );
      expect(
        storage.read(file.id),
        'a referenced logo lost its bytes',
      ).toBeDefined();
    }
    expect(rows.length).toBeLessThanOrEqual(1);
  }

  async function publicPage(): Promise<request.Response> {
    return request(app().server).get(apiPath(`/public/forms/${slug}`));
  }

  /** The status of the sessionless byte route for one reference. */
  async function publicFile(ref: string): Promise<number> {
    const answer = await request(app().server).get(
      apiPath(`/public/files/${ref}`),
    );
    return answer.status;
  }

  // -------------------------------------------------------------------------
  // the evidence — the upload arrives on the sessionless page
  // -------------------------------------------------------------------------

  it('puts an uploaded Logo on the public, sessionless fill-in page', async () => {
    const response = await upload(admin, png(512));

    expect(response.status).toBe(201);
    const body = response.body as Branding;
    expect(body.logoRef?.kind).toBe('upload');
    const ref = body.logoRef?.ref ?? '';
    expect(ref).not.toBe('');

    // **No session on this request at all** — not even a cookie header. That is
    // the whole point of the shore: there is no signed-in Organisation here against
    // which a reference could have been compared.
    const page = await publicPage();
    expect(page.status).toBe(200);
    expect(
      (page.body as { tenant: { logoRef: unknown } }).tenant.logoRef,
    ).toEqual({ kind: 'upload', ref });

    // And the address that reference names actually answers with the bytes —
    // otherwise „erscheint auf der Ausfüllseite" would be a field, not a Logo.
    const file = await request(app().server).get(
      apiPath(`/public/files/${ref}`),
    );
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('image/png');
    expect(file.headers['x-content-type-options']).toBe('nosniff');

    await expectInvariant(own);
  });

  // -------------------------------------------------------------------------
  // the evidence — the trust boundary, with a genuinely foreign file
  // -------------------------------------------------------------------------

  /**
   * **The reproduction for.** The other organisation uploads a Logo
   * of its own; its reference is then written into *this* organisation's `logo_ref`
   * past every schema, exactly as a raw write, an older version or a restore
   * would leave it.
   *
   * Two assertions, and the second is what makes the first mean something: the
   * public page of this organisation does **not** carry the reference, and the very
   * same reference *is* delivered to the organisation that owns it. Without the
   * counter-check, a gate that answered `null` to everything would pass.
   */
  it('never delivers another organisation’s Logo, and still delivers it to its owner', async () => {
    const foreign = await upload(otherAdmin, png(256));
    expect(foreign.status).toBe(201);
    const foreignRef = (foreign.body as Branding).logoRef?.ref ?? '';
    expect(foreignRef).not.toBe('');

    await app().prisma.$executeRawUnsafe(
      'UPDATE "tenant" SET "logo_ref" = $1 WHERE "id" = $2::uuid',
      foreignRef,
      own.id,
    );

    const page = await publicPage();
    expect(page.status).toBe(200);
    expect(page.text).not.toContain(foreignRef);
    expect(
      (page.body as { tenant: { logoRef: unknown } }).tenant.logoRef,
    ).toBeNull();

    // The counter-check: the same reference, read by its own Organisation.
    expect((await readBranding(otherAdmin)).logoRef).toEqual({
      kind: 'upload',
      ref: foreignRef,
    });

    // Put this organisation back on something it owns, so the invariant holds again.
    const restored = await upload(admin, png(128));
    expect(restored.status).toBe(201);
    await expectInvariant(own);
    await expectInvariant(other);
  });

  // -------------------------------------------------------------------------
  // The life cycle — ADR-0014 no. 15's open point, decided in this package
  // -------------------------------------------------------------------------

  it('replaces the previous Logo — bytes and row, not just the pointer', async () => {
    const first = await upload(admin, png(300));
    const firstRef = (first.body as Branding).logoRef?.ref ?? '';
    const firstRow = (await logoRows(own))[0];
    expect(firstRow).toBeDefined();
    expect(storage.read(firstRow?.id ?? '')).toBeDefined();

    const second = await upload(admin, png(400));
    const secondRef = (second.body as Branding).logoRef?.ref ?? '';
    expect(secondRef).not.toBe(firstRef);

    // The bytes are gone from the storage, not merely unreferenced — the
    // measurement is the **double**, not the repository, because a repository
    // that filters proves only that it filters (ADR-0014 no. 15).
    expect(storage.read(firstRow?.id ?? '')).toBeUndefined();
    expect(await logoRows(own)).toHaveLength(1);
    await expectInvariant(own);

    // And the address of the replaced Logo answers the ordinary 404, the
    // same one an invented reference gets.
    const gone = await request(app().server).get(
      apiPath(`/public/files/${firstRef}`),
    );
    expect(gone.status).toBe(404);
  });

  /**
   * **The way back** — „eine Organisation ohne eigenes Logo soll nicht in ein Loch
   * fallen" . Choosing a shipped asset again is a normal save,
   * and it is where the uploaded file goes: nothing else collects it, because
   * the purge deliberately touches no Logo.
   */
  it('takes the uploaded file when the organisation switches back to a shipped asset', async () => {
    const uploaded = await upload(admin, png(320));
    expect(uploaded.status).toBe(201);
    const row = (await logoRows(own))[0];
    expect(row).toBeDefined();
    expect(storage.read(row?.id ?? '')).toBeDefined();

    const document = uploaded.body as Branding;
    const saved = await saveBranding(admin, document, {
      logoRef: { kind: 'asset', ref: 'assets/beispiel-signet.svg' },
    });

    expect(saved.status).toBe(200);
    expect((saved.body as Branding).logoRef).toEqual({
      kind: 'asset',
      ref: 'assets/beispiel-signet.svg',
    });
    expect(await logoRows(own)).toHaveLength(0);
    expect(storage.read(row?.id ?? '')).toBeUndefined();
    await expectInvariant(own);

    // And the shipped choice is still the full list — the selection did not
    // shrink because an upload exists.
    expect((saved.body as Branding).logoChoices).toHaveLength(2);
  });

  /**
   * **A withdrawn Logo stops being delivered, even when the bytes stay**
   * (a security review finding).
   *
   * The sweep leaves the row standing when `remove()` fails, and that is
   * deliberate (no. 16): bytes with no row are unfindable. What it must *not*
   * mean is that the sessionless route goes on handing the image out — the organisation
   * has withdrawn it, and if it never touches its appearance again, „withdrawn"
   * would last for ever on paper and never in fact. no. 19 says a `tenant_logo`
   * exists exactly as long as `tenant.logo_ref` names it; the route asks that
   * question now instead of asking only about the row.
   *
   * *Reproduction:* drop `tenant: { logoRef: ref }` from the public lookup →
   * the address answers 200 and this case is red.
   */
  it('stops delivering a Logo the organisation withdrew, even if its bytes could not be removed', async () => {
    const uploaded = await upload(admin, png(360));
    expect(uploaded.status).toBe(201);
    const document = uploaded.body as Branding;
    const ref = document.logoRef?.ref ?? '';
    expect(await publicFile(ref)).toBe(200);

    // The volume goes away exactly at the moment the sweep wants to delete.
    storage.failNextRemoval();
    const saved = await saveBranding(admin, document, {
      logoRef: { kind: 'asset', ref: 'assets/beispiel-signet.svg' },
    });
    expect(saved.status).toBe(200);

    // The row is still there on purpose — and the Logo is gone all the same.
    expect(await logoRows(own)).toHaveLength(1);
    expect(await publicFile(ref)).toBe(404);
    expect(
      ((await publicPage()).body as { tenant: { logoRef: unknown } }).tenant
        .logoRef,
    ).toEqual({ kind: 'asset', ref: 'assets/beispiel-signet.svg' });
  });

  /**
   * **A failing `remove()` costs the file and nothing else** — a lesson
   * asserted in three paragraphs of `logo-sweep.ts` and measured by
   * nothing until two reviews said so.
   */
  it('keeps the branding save standing when the storage refuses', async () => {
    const uploaded = await upload(admin, png(380));
    const document = uploaded.body as Branding;

    storage.failNextRemoval();
    const saved = await saveBranding(admin, document, {
      logoRef: null,
      accent: '#123456',
    });

    // The save is the caller's business and it succeeded; the byte that could
    // not go is the sweep's, and it goes on the next branding write.
    expect(saved.status).toBe(200);
    expect((saved.body as Branding).accent).toBe('#123456');
    expect((saved.body as Branding).logoRef).toBeNull();

    const again = await saveBranding(admin, saved.body as Branding, {
      accent: '#654321',
    });
    expect(again.status).toBe(200);
    expect(await logoRows(own)).toHaveLength(0);
    await expectInvariant(own);
  });

  /**
   * **The sweep must not take a row whose bytes are still arriving** (found in
   * two separate reviews; measured by the security one).
   *
   * A row is written `pending` *before* its bytes (no. 4), and the sweep runs on
   * **every** branding write of this organisation — so a second tab saving a colour was
   * enough to delete an upload in flight. Then `put()` wrote the bytes with no
   * row left, and with no `list()` on the seam nothing in this application
   * could ever find them again: 201 with `logoRef: null`, a dangling
   * `tenant.logo_ref`, nought rows and bytes on the volume for good.
   *
   * Here the window is opened directly: a `pending` row of this organisation, exactly
   * as `createLogo` leaves it, while a colour save sweeps.
   *
   * *Reproduction:* drop `status: 'stored'` from `unreferencedLogoIds` → the
   * pending row is deleted and this case is red.
   */
  it('leaves a Logo row alone while its bytes are still arriving', async () => {
    const inFlight = await app().prisma.file.create({
      data: {
        tenantId: own.id,
        kind: 'tenant_logo',
        publicRef: 'InFlightAaBbCcDdEeFfGg',
        fileName: 'Logo.png',
        contentType: 'image/png',
        status: 'pending',
      },
      select: { id: true },
    });

    const document = await readBranding(admin);
    const saved = await saveBranding(admin, document, {
      accent: '#0055aa',
    });
    expect(saved.status).toBe(200);

    expect(
      await app().prisma.file.findUnique({ where: { id: inFlight.id } }),
    ).not.toBeNull();

    // Cleaned up by hand: this row never becomes a Logo, and leaving it would
    // make `expectInvariant` of the next case fail for the wrong reason.
    await app().prisma.file.delete({ where: { id: inFlight.id } });
  });

  /**
   * **An upload that left nothing behind must not answer 201** (a review finding).
   *
   * Storing and adopting are one transaction, and both writes are `updateMany`
   * — which answers „nought rows" as readily as „one". Without the count checks
   * a row that vanished while its bytes were arriving made both statements
   * no-op, the route answered 201, and the organisation found out at the next read that
   * its Logo was silently gone. The window is forced here rather than argued
   * about: the storage is parked after it has taken the bytes, the row is
   * deleted underneath, and the upload is released.
   *
   * *Reproduction:* drop the `stored.count !== 1` check → the request answers
   * 201 and this case is red on its first assertion.
   */
  it('fails loudly when the row disappears while the bytes are arriving', async () => {
    const before = await readBranding(admin);

    const gate = storage.holdNextPut();
    // `.then` rather than a bare call: a supertest `Test` does not send until
    // something subscribes to it, and the gate below would wait for a request
    // that never left.
    const inFlight = upload(admin, png(300)).then((answer) => answer);
    await gate.arrived;

    await app().prisma.file.deleteMany({
      where: { tenantId: own.id, kind: 'tenant_logo', status: 'pending' },
    });
    gate.release();

    const answer = await inFlight;
    expect(answer.status).toBe(500);

    // And nothing was adopted on the way — the organisation is exactly where it was.
    const after = await readBranding(admin);
    expect(after.logoRef).toEqual(before.logoRef);
    expect(after.revision).toBe(before.revision);
    await expectInvariant(own);
  });

  it('takes the uploaded file when the organisation chooses no Logo at all', async () => {
    const uploaded = await upload(admin, png(340));
    const row = (await logoRows(own))[0];

    const saved = await saveBranding(admin, uploaded.body as Branding, {
      logoRef: null,
    });

    expect(saved.status).toBe(200);
    expect((saved.body as Branding).logoRef).toBeNull();
    expect(await logoRows(own)).toHaveLength(0);
    expect(storage.read(row?.id ?? '')).toBeUndefined();
  });

  /**
   * The `upload` arm of the write schema means „behalte mein Logo", never
   * „nimm dieses". A save that names any other reference is refused **before**
   * the column moves — the delivery gate would refuse to hand a foreign one on,
   * but a column that can hold it is one unguarded read away from being
   * followed.
   */
  it('refuses a save that names an upload the organisation is not showing', async () => {
    const mine = await upload(admin, png(360));
    const document = mine.body as Branding;
    const foreignRef = (await readBranding(otherAdmin)).logoRef?.ref ?? '';
    expect(foreignRef).not.toBe('');

    for (const ref of [foreignRef, randomBytes(16).toString('base64url')]) {
      const refused = await saveBranding(admin, document, {
        logoRef: { kind: 'upload', ref },
      });

      expect(refused.status).toBe(400);
      expect((refused.body as { message: string }).message).toBe(
        UNKNOWN_LOGO_MESSAGE,
      );
    }

    // Unchanged: the organisation still shows its own file, and the file is still there.
    expect((await readBranding(admin)).logoRef).toEqual(document.logoRef);
    await expectInvariant(own);
  });

  it('accepts a save that keeps the upload, and keeps the file', async () => {
    const mine = await upload(admin, png(380));
    const document = mine.body as Branding;
    const row = (await logoRows(own))[0];

    const saved = await saveBranding(admin, document, { accent: '#123456' });

    expect(saved.status).toBe(200);
    expect((saved.body as Branding).logoRef).toEqual(document.logoRef);
    expect(storage.read(row?.id ?? '')).toBeDefined();
    await expectInvariant(own);
  });

  // -------------------------------------------------------------------------
  // The narrow list — and the difference to the attachment list
  // -------------------------------------------------------------------------

  it.each([
    ['an SVG', SVG],
    ['a PDF, which the attachment list does allow', pdf(128)],
  ])('refuses %s as a Logo and writes nothing', async (_name, body) => {
    const before = await logoRows(own);
    const stored = storage.size;

    const response = await upload(admin, body, { fileName: 'logo.png' });

    expect(response.status).toBe(415);
    expect((response.body as { message: string }).message).toContain('SVG');
    expect(await logoRows(own)).toEqual(before);
    expect(storage.size).toBe(stored);
  });

  it('refuses a file above the Logo limit before it is stored', async () => {
    const before = await logoRows(own);
    const stored = storage.size;

    const response = await upload(admin, png(MAX_TENANT_LOGO_BYTES + 1024));

    expect(response.status).toBe(413);
    // Nothing was kept — the row of a failed write is removed by the pipeline
    // and `put()` leaves nothing behind (ADR-0014 no. 1).
    expect(await logoRows(own)).toEqual(before);
    expect(storage.size).toBe(stored);
  });

  it('refuses a body that is not application/octet-stream', async () => {
    const response = await upload(admin, png(64), {
      contentType: 'multipart/form-data',
    });

    expect(response.status).toBe(415);
  });

  // -------------------------------------------------------------------------
  // The guard chain, and the one difference to the public upload
  // -------------------------------------------------------------------------

  it('refuses a request without a session', async () => {
    const response = await request(app().server)
      .post(apiPath('/tenant/branding/logo'))
      .set('Content-Type', 'application/octet-stream')
      .set('X-File-Name', 'logo.png')
      .send(png(64));

    expect(response.status).toBe(401);
  });

  /**
   * **Not `@CsrfExempt()`**, unlike the public upload of ADR-0014 no. 14: this
   * route rides a session, so a cross-site form post must not reach it. The
   * cookie is sent and the header is not — which is exactly the shape of the
   * attack.
   */
  it('refuses a session request without the CSRF header', async () => {
    const before = await logoRows(own);

    const response = await request(app().server)
      .post(apiPath('/tenant/branding/logo'))
      .set('Cookie', cookieHeader(admin))
      .set('Content-Type', 'application/octet-stream')
      .set('X-File-Name', 'logo.png')
      .send(png(64));

    expect(response.status).toBe(403);
    expect(await logoRows(own)).toEqual(before);
  });

  it('refuses a member who holds every right but Einstellungen', async () => {
    const before = await logoRows(own);

    const response = await upload(withoutSettings, png(64));

    expect(response.status).toBe(403);
    expect((response.body as { message: string }).message).toBe(
      MISSING_PERMISSION_MESSAGE,
    );
    expect(await logoRows(own)).toEqual(before);
  });
});
