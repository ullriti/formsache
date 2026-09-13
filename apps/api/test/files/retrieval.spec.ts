import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resetAddressFormAllowances } from '../../src/public/address-form-tracker';
import { resetUploadQuota } from '../../src/public/upload-quota';
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
import { cookieHeader, openSession } from '../support/http';
import { InMemoryFileStorage } from '../support/in-memory-file-storage';

/**
 * **The requirement — two ways, two rules, and the difference between them is
 * what decides which applies** (ADR-0014 no. 9, 11).
 *
 * The Logo is deliberately public and embedded; the attachment of an answer
 * is explicitly neither. A suite that only measured the permitted case of each
 * would prove nothing (`CONTRIBUTING.md`), so almost everything below is a
 * refusal, and every refusal is compared **byte for byte** against what an
 * invented but well-formed reference gets on the same route.
 *
 * ## Why the rows are planted rather than uploaded
 *
 * There is no route that writes a `tenant_logo` row yet — the Logo upload is
 * a separate concern — and the attachment claim needs a whole submission to reach the
 * one state this suite is about. Planting the rows states the *precondition*
 * instead of deriving it from three other preconditions, and it is also the only way
 * to reach the rows this suite most needs: a `tenant_logo` carrying a type off
 * the Logo list, and a file whose `tenant_id` and `form_id` name two
 * different Organisationen. Both are expressible through a raw write (ADR-0014 no. 3)
 * and through nothing else.
 *
 * The one thing **not** planted is the reference itself: the unguessability
 * block at the end drives the shipped upload route, because „aus einem CSPRNG"
 * is a claim about the code that mints them.
 *
 * *Reproductions, run against this suite and measured — the results:*
 * - `tenantId` removed from `ScopedFileDelegate.findAttachmentByRef`'s `where`
 *   → „another organisation's attachment" goes red.
 * - `deliverableContentType` replaced by „the stored value" → the two
 *   „unexpected type" cases go red.
 * - `disposition: 'attachment'` replaced by `'inline'` → the disposition case
 *   goes red.
 */

const PAGE = '019ff500-0000-7000-8000-0000000000a0';
const NAME = '019ff500-0000-7000-8000-000000000001';

const definition = {
  pages: [
    {
      id: PAGE,
      title: 'Anmeldung',
      questions: [
        {
          id: NAME,
          type: 'text',
          label: 'Name',
          hint: null,
          required: false,
          width: 'full',
          minLength: null,
          maxLength: null,
          pattern: null,
        },
      ],
    },
  ],
};

/** A real PNG header plus filler — the bytes a Logo row points at. */
function png(size = 64): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);
}

function pdf(size = 96): Buffer {
  const head = Buffer.from('%PDF-1.7\n');
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);
}

/** A reference of the shape the upload mints — 16 bytes, base64url. */
function ref(): string {
  return randomBytes(16).toString('base64url');
}

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

interface PlantedFile {
  readonly id: string;
  readonly ref: string;
}

/** One row as a raw write would leave it — see the block comment above. */
interface PlantInput {
  readonly kind: 'tenant_logo' | 'response_attachment';
  readonly tenantId: string;
  readonly formId?: string | null;
  readonly responseId?: string | null;
  readonly contentType?: string;
  readonly fileName?: string;
  readonly status?: 'pending' | 'stored';
  /** `null` writes the row and **no** bytes — the crash window of no. 4. */
  readonly bytes?: Buffer | null;
}

describe('retrieving a stored file', () => {
  let database: TestDatabase;
  let testApp: TestApp;
  let storage: InMemoryFileStorage;

  /** The organisation everything belongs to, and the organisation nothing belongs to. */
  let home: TenantFixture;
  let foreign: TenantFixture;
  let homeFormId: string;
  let foreignFormId: string;
  let homeResponseId: string;

  /** Sessions: an editor of each organisation, plus two narrowed members of `home`. */
  let homeEditor: string;
  let foreignEditor: string;
  let blindMember: string;
  let lockedMemberId: string;
  let lockedMember: string;

  const prisma = (): TestApp['prisma'] => testApp.prisma;

  /**
   * One `file` row plus its bytes, written the way a raw write would leave
   * them — see the block comment above for why.
   */
  async function plant(data: PlantInput): Promise<PlantedFile> {
    const publicRef = ref();
    const row = await prisma().file.create({
      data: {
        tenantId: data.tenantId,
        kind: data.kind,
        formId: data.formId ?? null,
        responseId: data.responseId ?? null,
        publicRef,
        fileName: data.fileName ?? 'Nachweis.pdf',
        contentType: data.contentType ?? 'application/pdf',
        status: data.status ?? 'stored',
      },
      select: { id: true },
    });
    if (data.bytes !== null) {
      await storage.put(row.id, Readable.from([data.bytes ?? pdf()]), {
        maxBytes: 1024 * 1024,
      });
    }
    // **A Logo is one only while its organisation names it** (ADR-0014 no. 19), and
    // and since a security review the public route asks exactly that — a
    // planted row alone is a file, not a Logo. Planting the reference with it
    // keeps these cases about delivery instead of about adoption; the cases
    // that are *about* the reference set it themselves.
    if (data.kind === 'tenant_logo') {
      await prisma().tenant.update({
        where: { id: data.tenantId },
        data: { logoRef: publicRef },
      });
    }
    return { id: row.id, ref: publicRef };
  }

  const logoUrl = (value: string): string => apiPath(`/public/files/${value}`);
  const attachmentUrl = (value: string): string =>
    apiPath(`/responses/files/${value}`);

  beforeAll(async () => {
    database = await acquireTestDatabase();
    storage = new InMemoryFileStorage();
    testApp = await createTestApp({
      databaseUrl: database.url,
      env: { TRUST_PROXY_HOPS: 1 },
      storage,
    });

    home = await createTenant(prisma(), 'HOME');
    foreign = await createTenant(prisma(), 'FOREIGN');

    homeFormId = await createForm(home, 'Anmeldung Jahrestagung');
    foreignFormId = await createForm(
      foreign,
      'Anmeldung der anderen Organisation',
    );

    const version = await prisma().formVersion.findFirstOrThrow({
      where: { formId: homeFormId },
      select: { id: true },
    });
    const response = await prisma().response.create({
      data: {
        tenantId: home.id,
        formId: homeFormId,
        formVersionId: version.id,
        answers: { [NAME]: 'Anton Bauer' },
      },
      select: { id: true },
    });
    homeResponseId = response.id;

    const homeUser = await createUser(prisma(), {
      email: 'editor@home.example',
      password: 'test-password',
      tenants: [home],
    });
    homeEditor = await openSession(testApp, homeUser.id, home.id);

    const foreignUser = await createUser(prisma(), {
      email: 'editor@foreign.example',
      password: 'test-password',
      tenants: [foreign],
    });
    foreignEditor = await openSession(testApp, foreignUser.id, foreign.id);

    // Holds **every other** right — only `can_view_responses` is missing, so a
    // refusal cannot be „irgendein Guard hat gefeuert".
    const blind = await createRestrictedMember(prisma(), home, {
      email: 'blind@home.example',
      groupName: 'ohne-antworten',
      permissions: {
        canBuild: true,
        canViewResponses: false,
        canExport: true,
        canManageSettings: true,
        canManageFormSettings: true,
        canManageUsers: true,
      },
    });
    blindMember = await openSession(testApp, blind.id, home.id);

    const locked = await createRestrictedMember(prisma(), home, {
      email: 'locked@home.example',
      groupName: 'gesperrt-auf-formular',
      permissions: { canViewResponses: true },
    });
    lockedMemberId = locked.id;
    lockedMember = await openSession(testApp, locked.id, home.id);
    await prisma().formPermission.create({
      data: {
        tenantId: home.id,
        formId: homeFormId,
        userId: lockedMemberId,
        accessRevoked: true,
      },
    });
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database.release();
  }, 120_000);

  beforeEach(async () => {
    await prisma().file.deleteMany();
    resetUploadQuota();
    resetAddressFormAllowances();
  });

  async function createForm(
    tenant: TenantFixture,
    title: string,
  ): Promise<string> {
    const form = await prisma().form.create({
      data: {
        tenantId: tenant.id,
        title,
        draftSchema: definition,
        publicSlug: randomBytes(16).toString('base64url'),
        status: 'active',
      },
      select: { id: true },
    });
    const version = await prisma().formVersion.create({
      data: {
        tenantId: tenant.id,
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
    return form.id;
  }

  // -------------------------------------------------------------------------
  // (a) The Logo — public on purpose, embedded (ADR-0014 no. 11a)
  // -------------------------------------------------------------------------

  describe('the Logo, without any session (Nr. 11a)', () => {
    it('delivers it inline, with a fixed type and nosniff', async () => {
      const bytes = png(512);
      const file = await plant({
        kind: 'tenant_logo',
        tenantId: home.id,
        contentType: 'image/png',
        fileName: 'Logo Musterstadt.png',
        bytes,
      });

      const response = await request(testApp.server).get(logoUrl(file.ref));

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      // **`inline`, not `attachment`** — die Spezifikation says the Logo is
      // embedded, and the protection of this route is the list plus `nosniff`,
      // never the disposition.
      expect(response.headers['content-disposition']).toContain('inline;');
      expect(response.headers['content-disposition']).toContain(
        "filename*=UTF-8''Logo%20Musterstadt.png",
      );
      // Load-bearing here rather than decoration: the bytes come from the same
      // origin as the application, so „der Browser deutet das als HTML" would
      // be XSS in our own origin.
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Buffer.from(response.body as Uint8Array).equals(bytes)).toBe(true);
    });

    /**
     * **The case ADR-0014 no. 11a writes out**: 404, not 415, and above all not
     * `application/octet-stream` or the stored string. Both kinds live in one
     * table and the attachment list contains `application/pdf`, so this row is
     * reachable through a raw write — and „was liefert es dann aus" must not
     * belong to the implementation's mood.
     */
    it('answers 404 for a Logo whose type is off the Logo list', async () => {
      const file = await plant({
        kind: 'tenant_logo',
        tenantId: home.id,
        contentType: 'application/pdf',
        bytes: pdf(),
      });

      const response = await request(testApp.server).get(logoUrl(file.ref));
      const invented = await request(testApp.server).get(logoUrl(ref()));

      expect(response.status).toBe(404);
      expect(response.text).toBe(invented.text);
      expect(response.headers['content-type']).not.toContain('application/pdf');
      expect(response.text).not.toContain('octet-stream');
    });

    /**
     * The row shape a `tenant_logo` could never be *inserted* as but could be
     * written as: `image/svg+xml`. The list is what keeps a script out of a
     * page an organisation's members trust.
     */
    it('answers 404 for an SVG Logo', async () => {
      const file = await plant({
        kind: 'tenant_logo',
        tenantId: home.id,
        contentType: 'image/svg+xml',
        fileName: 'logo.svg',
        bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      });

      const response = await request(testApp.server).get(logoUrl(file.ref));

      expect(response.status).toBe(404);
      expect(response.headers['content-type']).not.toContain('svg');
    });

    /**
     * **The public route is not a second door to an attachment.** `kind` is a
     * condition of the statement, so this resolves to nothing at all — the same
     * answer, from the same code path, as an invented reference.
     */
    it('answers 404 for an attachment reference', async () => {
      const file = await plant({
        kind: 'response_attachment',
        tenantId: home.id,
        formId: homeFormId,
        responseId: homeResponseId,
      });

      const response = await request(testApp.server).get(logoUrl(file.ref));
      const invented = await request(testApp.server).get(logoUrl(ref()));

      expect(response.status).toBe(404);
      expect(response.text).toBe(invented.text);
    });

    it('answers 404 for a Logo row whose bytes were never written', async () => {
      const file = await plant({
        kind: 'tenant_logo',
        tenantId: home.id,
        contentType: 'image/png',
        status: 'pending',
        bytes: null,
      });

      const response = await request(testApp.server).get(logoUrl(file.ref));

      expect(response.status).toBe(404);
    });

    /**
     * A malformed reference is a **404, never a 500**. `%00` arrives decoded as
     * a NUL byte, PostgreSQL refuses U+0000 in `text`, and an unguarded query
     * throws — the one answer that would tell a stranger their guess had a
     * different shape from the others.
     *
     * **`a/b` is deliberately not in this list**, and the reason is worth the
     * sentence: a slash makes it a *different path*, so Express answers its own
     * „Cannot GET …" before this route is reached. That body differs from the
     * one below — measured, not assumed — and it is not an oracle: every
     * two-segment path under this prefix gets it, whether anything exists or
     * not, and no reference this application mints can contain a slash
     * (`isFileRef`). Asserting equality there would be asserting something
     * about Express's router.
     */
    it.each(['a b', 'x'.repeat(201), '%00', 'a.b', '~tilde'])(
      'answers a malformed reference %j like an invented one',
      async (value) => {
        const response = await request(testApp.server).get(logoUrl(value));
        const invented = await request(testApp.server).get(logoUrl(ref()));

        expect(response.status).toBe(404);
        expect(response.text).toBe(invented.text);
      },
    );
  });

  // -------------------------------------------------------------------------
  // (b) The attachment — the whole guard chain (ADR-0014 no. 11b)
  // -------------------------------------------------------------------------

  describe('the attachment of an answer (Nr. 11b)', () => {
    /** A claimed attachment of `home`'s only answer. */
    async function ownAttachment(
      overrides: Partial<PlantInput> = {},
    ): Promise<PlantedFile> {
      return plant({
        kind: 'response_attachment',
        tenantId: home.id,
        formId: homeFormId,
        responseId: homeResponseId,
        ...overrides,
      });
    }

    it('delivers it to an editor of the owning Organisation, as a download', async () => {
      const bytes = pdf(256);
      const file = await ownAttachment({
        fileName: 'Nachweis Müller.pdf',
        bytes,
      });

      const response = await request(testApp.server)
        .get(attachmentUrl(file.ref))
        .set('Cookie', cookieHeader(homeEditor));

      expect(response.status).toBe(200);
      // Fixed, from the attachment list — never the stored column.
      expect(response.headers['content-type']).toBe('application/pdf');
      // **`attachment`, never `inline`** (no. 11b): these bytes were chosen by
      // a stranger, and „kein Browser rendert das in unserem Origin" is the
      // whole protection a PDF gets here.
      expect(response.headers['content-disposition']).toContain('attachment;');
      expect(response.headers['content-disposition']).toContain(
        "filename*=UTF-8''Nachweis%20M%C3%BCller.pdf",
      );
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Buffer.from(response.body as Uint8Array).equals(bytes)).toBe(true);
    });

    /**
     * **the evidence, first half.** An unauthenticated caller must not be able to
     * tell a real reference from an invented one — and the comparison is the
     * whole assertion, not the status code on its own.
     *
     * **The one place this suite does not take ADR-0014 no. 11b literally**, and
     * it is named rather than glossed: the ADR says „ohne Sitzung: 404", and
     * what this route answers is the chain's ordinary **401**. The property it
     * protects is unharmed — `SessionGuard` refuses *before* anything
     * about the reference is read, so the answer cannot depend on whether the
     * file exists, which is exactly what the comparison below measures. What a
     * 404 would cost is real: an editor whose session expired would be told
     * „die Datei gibt es nicht" about a file that is sitting there, and would
     * have no reason to log in again. The deviation is called out in ADR-0014.
     */
    it('tells an unauthenticated caller nothing about a reference', async () => {
      const file = await ownAttachment();

      const real = await request(testApp.server).get(attachmentUrl(file.ref));
      const invented = await request(testApp.server).get(attachmentUrl(ref()));

      expect(real.status).not.toBe(200);
      expect(real.status).toBe(invented.status);
      expect(real.text).toBe(invented.text);
      expect(real.text).not.toContain('Nachweis');
      expect(real.headers['content-type']).not.toContain('application/pdf');
    });

    /**
     * **the evidence, second half — and the reproduction the requirement names.**
     * Remove `tenantId` from `ScopedFileDelegate.findAttachmentByRef`'s `where`
     * and this case goes green where it must be red. `file` has no composite
     * foreign key on `(form_id, tenant_id)` (ADR-0014 no. 3), so nothing
     * underneath would catch it.
     */
    it('answers a session of the wrong Organisation byte-identically to an invented reference', async () => {
      const file = await ownAttachment();

      const real = await request(testApp.server)
        .get(attachmentUrl(file.ref))
        .set('Cookie', cookieHeader(foreignEditor));
      const invented = await request(testApp.server)
        .get(attachmentUrl(ref()))
        .set('Cookie', cookieHeader(foreignEditor));

      expect(real.status).toBe(404);
      expect(real.status).toBe(invented.status);
      expect(real.text).toBe(invented.text);
      expect(real.text).not.toContain('Nachweis');
    });

    /**
     * The row ADR-0014 no. 13 condition 2 exists against, seen from the
     * retrieval side: `form_id` of one organisation, `tenant_id` of the other. It is
     * expressible through a raw write, and the retrieval reads through
     * `tenant_id` — so **neither** Organisation may get it. The claim refuses to create
     * it; this is the second bolt.
     */
    it('delivers a row whose tenant and form disagree to nobody', async () => {
      const file = await plant({
        kind: 'response_attachment',
        // The organisation of the row…
        tenantId: home.id,
        // …and a form of the other one.
        formId: foreignFormId,
        responseId: homeResponseId,
      });

      for (const session of [homeEditor, foreignEditor]) {
        const response = await request(testApp.server)
          .get(attachmentUrl(file.ref))
          .set('Cookie', cookieHeader(session));

        expect(response.status).toBe(404);
      }
    });

    it('answers 404 for an upload nobody has claimed yet', async () => {
      // Before the submission this file belongs to no answer at all, and the
      // purge of no. 15 removes it after a day. Handing it to an editor would
      // be a stranger's in-flight file.
      const file = await plant({
        kind: 'response_attachment',
        tenantId: home.id,
        formId: homeFormId,
        responseId: null,
      });

      const response = await request(testApp.server)
        .get(attachmentUrl(file.ref))
        .set('Cookie', cookieHeader(homeEditor));

      expect(response.status).toBe(404);
    });

    it('answers 404 once the answer is in the Papierkorb', async () => {
      const file = await ownAttachment();
      await prisma().response.update({
        where: { id: homeResponseId },
        data: { deletedAt: new Date() },
      });

      const response = await request(testApp.server)
        .get(attachmentUrl(file.ref))
        .set('Cookie', cookieHeader(homeEditor));

      await prisma().response.update({
        where: { id: homeResponseId },
        data: { deletedAt: null },
      });

      expect(response.status).toBe(404);
    });

    /**
     * **…and once the *form* is** (a security review finding).
     *
     * Deleting a form leaves its answers at `deleted_at IS NULL` — the
     * trash holds the form, not each answer separately — so the
     * answer-only filter one case above did not cover this at all. Everything
     * else went dark on cue (answers table, export, public address, every edit
     * link answers 404) while this one route carried on handing out the bytes
     * of a stranger's uploaded power of attorney to anybody who had noted the
     * `public_ref` down from the answers view beforehand.
     *
     * Asserted against an invented reference rather than as „404", for the
     * reason the two cases above are: a different body would be the oracle.
     *
     * *Reproduction, measured on 2026-08-03:* dropping `form: { deletedAt: null }`
     * from `ScopedFileDelegate.findAttachmentByRef` answers **200 with the
     * bytes** here and leaves every other case in this file green.
     */
    it('answers 404 once the form of the answer is in the Papierkorb', async () => {
      const bytes = pdf(256);
      const file = await ownAttachment({ fileName: 'Vollmacht.pdf', bytes });
      expect(
        (
          await request(testApp.server)
            .get(attachmentUrl(file.ref))
            .set('Cookie', cookieHeader(homeEditor))
        ).status,
      ).toBe(200);

      await prisma().form.update({
        where: { id: homeFormId },
        data: { deletedAt: new Date() },
      });

      const real = await request(testApp.server)
        .get(attachmentUrl(file.ref))
        .set('Cookie', cookieHeader(homeEditor));
      const invented = await request(testApp.server)
        .get(attachmentUrl(ref()))
        .set('Cookie', cookieHeader(homeEditor));

      // The answer itself never went into the trash — that is the state
      // deleting a form leaves, and the state the old `where` waved through.
      expect(
        (
          await prisma().response.findUniqueOrThrow({
            where: { id: homeResponseId },
            select: { deletedAt: true },
          })
        ).deletedAt,
      ).toBeNull();

      await prisma().form.update({
        where: { id: homeFormId },
        data: { deletedAt: null },
      });
      const restored = await request(testApp.server)
        .get(attachmentUrl(file.ref))
        .set('Cookie', cookieHeader(homeEditor));

      expect(real.status).toBe(404);
      expect(real.status).toBe(invented.status);
      expect(real.text).toBe(invented.text);
      expect(real.text).not.toContain('Vollmacht');
      // …and it is a withholding, not a deletion: the file comes back with the
      // form, byte for byte.
      expect(restored.status).toBe(200);
      expect(Buffer.from(restored.body as Uint8Array).equals(bytes)).toBe(true);
    });

    it('answers 404 for a Logo reference', async () => {
      const file = await plant({
        kind: 'tenant_logo',
        tenantId: home.id,
        contentType: 'image/png',
        bytes: png(),
      });

      const response = await request(testApp.server)
        .get(attachmentUrl(file.ref))
        .set('Cookie', cookieHeader(homeEditor));

      expect(response.status).toBe(404);
    });

    /**
     * The **stored** type is never echoed. `text/html` in the column is what a
     * raw write leaves, and delivering it would be XSS in our own origin — from
     * the one route that is *supposed* to hand personal files to editors.
     */
    it('answers 404 for a stored type that is on neither list', async () => {
      const file = await ownAttachment({
        contentType: 'text/html',
        fileName: 'nachweis.html',
        bytes: Buffer.from('<script>alert(1)</script>'),
      });

      const response = await request(testApp.server)
        .get(attachmentUrl(file.ref))
        .set('Cookie', cookieHeader(homeEditor));

      expect(response.status).toBe(404);
      expect(response.headers['content-type']).not.toContain('text/html');
      expect(response.text).not.toContain('<script>');
    });

    it('answers 404 for a row whose bytes are gone', async () => {
      const file = await ownAttachment();
      // The crash window of no. 4, and the state the purge leaves between its
      // `remove()` and its `delete` — a clean 404, never a truncated download.
      await storage.remove(file.id);

      const response = await request(testApp.server)
        .get(attachmentUrl(file.ref))
        .set('Cookie', cookieHeader(homeEditor));

      expect(response.status).toBe(404);
    });

    /**
     * The third link of the chain, on a member who holds **every other** right.
     * 403 rather than 404, exactly like `GET /forms/:id/responses`: the caller
     * is inside the organisation and the answer is about their rights, not about the
     * existence of the file.
     */
    it('refuses a member of the organisation without can_view_responses', async () => {
      const file = await ownAttachment();

      const response = await request(testApp.server)
        .get(attachmentUrl(file.ref))
        .set('Cookie', cookieHeader(blindMember));

      expect(response.status).toBe(403);
      expect(response.text).not.toContain('Nachweis');
    });

    /**
     * The **fourth** link, which no guard can reach here: the form hangs off
     * the answer, two reads in. 404 and byte-identical to an invented
     * reference — a 403 would confirm that the file exists and that somebody
     * locked this person out of its form.
     */
    it('answers 404 for a member locked out of the answer’s form', async () => {
      const file = await ownAttachment();

      const real = await request(testApp.server)
        .get(attachmentUrl(file.ref))
        .set('Cookie', cookieHeader(lockedMember));
      const invented = await request(testApp.server)
        .get(attachmentUrl(ref()))
        .set('Cookie', cookieHeader(lockedMember));

      expect(real.status).toBe(404);
      expect(real.text).toBe(invented.text);
    });

    it.each(['a b', '%00', 'a.b', 'x'.repeat(201)])(
      'answers a malformed reference %j like an invented one',
      async (value) => {
        const real = await request(testApp.server)
          .get(attachmentUrl(value))
          .set('Cookie', cookieHeader(homeEditor));
        const invented = await request(testApp.server)
          .get(attachmentUrl(ref()))
          .set('Cookie', cookieHeader(homeEditor));

        expect(real.status).toBe(404);
        expect(real.text).toBe(invented.text);
      },
    );
  });

  // -------------------------------------------------------------------------
  // the evidence — the reference is not guessable
  // -------------------------------------------------------------------------

  /**
   * **The references the shipped route actually mints** (ADR-0014 no. 9).
   *
   * Driven through `POST /api/public/forms/:slug/files` rather than asserted
   * about `mintFileRef`, because „aus einem CSPRNG" is a claim about what
   * reaches the column. Two addresses, ten uploads each: the route allows ten a
   * minute per address ⊕ form, so a single address would be measuring the rate
   * limit instead.
   *
   * **What the byte-length check does *not* catch, said plainly because it was
   * measured:** a padded counter (`AAAAAAAAAAAAAAAAAAAA01`) has the
   * right alphabet, the right character count, and decodes to exactly sixteen
   * bytes — twenty-two base64url characters always do, whatever produced them.
   * The length assertion below stays **green** against it. The one that goes
   * red is the prefix probe, and that is where the claim rests.
   */
  describe('the reference', () => {
    let lastAddress = ownAddress();

    async function mintRefs(count: number): Promise<string[]> {
      const slug = await prisma()
        .form.findUniqueOrThrow({
          where: { id: homeFormId },
          select: { publicSlug: true },
        })
        .then((row) => row.publicSlug);

      const refs: string[] = [];
      // Ten per address is the route's own ceiling (ADR-0014 no. 8).
      for (let index = 0; index < count; index += 1) {
        const address = index % 10 === 0 ? ownAddress() : lastAddress;
        lastAddress = address;
        const response = await request(testApp.server)
          .post(apiPath(`/public/forms/${slug}/files`))
          .set('X-Forwarded-For', address)
          .set('Content-Type', 'application/octet-stream')
          .set(
            'X-File-Name',
            encodeURIComponent(`nachweis-${String(index)}.png`),
          )
          .send(png(32));
        expect(response.status).toBe(201);
        refs.push((response.body as { ref: string }).ref);
      }
      return refs;
    }

    it('is 128 bits from the alphabet of the public_slug', async () => {
      const refs = await mintRefs(2);

      for (const value of refs) {
        expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
        // A floor rather than a second definition of the format: 22 characters
        // of a narrower alphabet would decode to fewer than 16 bytes.
        expect(value.length).toBeGreaterThanOrEqual(22);
        expect(Buffer.from(value, 'base64url').length).toBeGreaterThanOrEqual(
          16,
        );
      }
      expect(refs[0]).not.toBe(refs[1]);

      // Nothing about the row is recoverable from the address — the reason it
      // is not the `id`, which is a time-ordered UUIDv7 (no. 9).
      const first = refs[0] ?? '';
      const row = await prisma().file.findFirstOrThrow({
        where: { publicRef: first },
        select: { id: true, tenantId: true, formId: true },
      });
      expect(first).not.toContain(row.id);
      expect(first).not.toContain(row.tenantId);
      expect(row.formId).not.toBeNull();
      expect(first).not.toContain(String(row.formId));
    }, 60_000);

    /**
     * The coarse distribution probe, applied here. Two claims, both
     * weak on purpose — this is a sanity check on the *source*, not a
     * statistical test:
     *
     * - all twenty are distinct (a counter passes this, which is why it is not
     *   alone);
     * - no two share their first four characters — 24 bits, so a genuine
     *   collision among twenty CSPRNG values is about one in 10⁵, while every
     *   sequential or time-derived scheme collides on the whole prefix at once.
     */
    it('draws twenty references with no shared prefix', async () => {
      const refs = await mintRefs(20);

      expect(new Set(refs).size).toBe(20);
      const prefixes = refs.map((value) => value.slice(0, 4));
      expect(new Set(prefixes).size).toBe(20);
    }, 120_000);
  });
});
