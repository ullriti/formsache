import { randomBytes } from 'node:crypto';

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  MAX_ATTACHMENT_BYTES,
  UNCLAIMED_FILE_LIFETIME_MS,
} from '@formsache/shared';

import { FilePurgeService } from '../../src/files/purge/file-purge.service';

import { resetAddressFormAllowances } from '../../src/public/address-form-tracker';
import { SettingsSecretsService } from '../../src/settings/settings-secrets.service';
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
import { createTenant, type TenantFixture } from '../support/fixtures';
import { NO_SECTIONS } from '../support/settings-sections';
import { InMemoryFileStorage } from '../support/in-memory-file-storage';

/**
 * **The life of an attachment across the two public write paths** — the requirement, ADR-0014 no. 13.
 *
 * The claim's five conditions are measured next door
 * (`attachment-claim.spec.ts`) against the function; this file measures what a
 * participant actually does, through the shipped routes: upload, submit,
 * correct, remove. Two of the four are a later addition and neither is
 * expressible against the claim alone.
 *
 * 1. **What a correction removes loses its owner.** Until then the edit path
 *    only ever claimed, so a removed attachment stayed owned by the answer that
 *    no longer names it — and the purge of no. 15, which takes only files
 *    *without* an owner, would never look at it again. That is not an untidy
 *    row: it is the bytes of somebody's certificate staying on the volume for
 *    good, which is the deletion promise of ADR-0014 no. 15 quietly unkept.
 *    *Reproduction:* drop the `releaseAttachments` call from `storeEditWithMails`
 *    → „forgets an attachment the correction removed" is red.
 * 2. **A correction can upload, through a door of its own.** The submission's
 *    upload route runs the *submission* chain, including the password gate; an
 *    edit token holder has no access word (the confirmation mail carries none),
 *    so a protected form would let them change every answer except the one that
 *    needs a new scan.
 *
 * `TRUST_PROXY_HOPS: 1` and a fresh `X-Forwarded-For` per request, for the
 * reason `upload.spec.ts` and `response-edit.spec.ts` both state: the public
 * write routes are rate limited per address, and a suite sharing one address
 * measures the limit instead of the thing under test.
 */

const PAGE = '019ff500-0000-7000-8000-0000000000a0';
const NAME = '019ff500-0000-7000-8000-000000000001';
const NACHWEIS = '019ff500-0000-7000-8000-000000000002';

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
        {
          id: NACHWEIS,
          type: 'file',
          label: 'Nachweis',
          hint: null,
          required: false,
          width: 'full',
          maxFiles: 2,
        },
      ],
    },
  ],
};

/** A real PDF header plus filler — the content is what the server checks. */
function pdf(size = 64): Buffer {
  const head = Buffer.from('%PDF-1.7\n');
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);
}

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

interface Uploaded {
  ref: string;
  fileName: string;
}

describe('the life of an attachment ', () => {
  let database: TestDatabase;
  let testApp: TestApp;
  let storage: InMemoryFileStorage;
  let tenant: TenantFixture;
  let slug: string;
  let formId: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    storage = new InMemoryFileStorage();
    testApp = await createTestApp({
      databaseUrl: database.url,
      env: { TRUST_PROXY_HOPS: 1 },
      storage,
    });

    tenant = await createTenant(testApp.prisma, 'ATTACH');
    slug = randomBytes(16).toString('base64url');
    const form = await testApp.prisma.form.create({
      data: {
        tenantId: tenant.id,
        title: 'Anmeldung mit Nachweis',
        draftSchema: definition,
        publicSlug: slug,
        status: 'active',
      },
    });
    formId = form.id;
    const version = await testApp.prisma.formVersion.create({
      data: {
        tenantId: tenant.id,
        formId: form.id,
        version: 1,
        schema: definition,
      },
    });
    // „Bearbeiten nach Absenden" on — what makes the edit token usable at all
    // , and the whole second half of this suite. Sealed through the
    // application's **own** service, the way an editor's save writes it, so the
    // document under test is one this server reads back rather than one it
    // refuses (fail closed).
    const secrets = testApp.app.get(SettingsSecretsService);
    await testApp.prisma.form.update({
      where: { id: form.id },
      data: {
        publishedVersionId: version.id,
        settingsOverride: secrets.sealFormOverride(
          {
            overridden: { ...NO_SECTIONS, access: true },
            values: { allowEdit: true },
          },
          tenant.id,
          form.id,
        ),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database.release();
  }, 120_000);

  afterEach(() => {
    resetUploadQuota();
    resetAddressFormAllowances();
  });

  /** One upload through the public form's door. */
  async function upload(fileName: string): Promise<Uploaded> {
    const answer = await request(app().server)
      .post(apiPath(`/public/forms/${slug}/files`))
      .set('X-Forwarded-For', ownAddress())
      .set('Content-Type', 'application/octet-stream')
      .set('X-File-Name', encodeURIComponent(fileName))
      .send(pdf());
    expect(answer.status).toBe(201);
    return answer.body as Uploaded;
  }

  /** One upload through the **edit token's** door. */
  async function uploadForEdit(
    token: string,
    fileName: string,
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/responses/${token}/files`))
      .set('X-Forwarded-For', ownAddress())
      .set('Content-Type', 'application/octet-stream')
      .set('X-File-Name', encodeURIComponent(fileName))
      .send(pdf());
  }

  const answerWith = (files: readonly Uploaded[]): Record<string, unknown> => ({
    [NAME]: 'Anton',
    [NACHWEIS]: {
      files: files.map((file) => ({ ref: file.ref, name: file.fileName })),
    },
  });

  async function submit(
    answers: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers });
  }

  async function writeEdit(
    token: string,
    answers: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app().server)
      .put(apiPath(`/public/responses/${token}`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers });
  }

  /** The edit token of the one answer this form carries at the moment. */
  async function tokenOfLatest(): Promise<string> {
    const row = await app().prisma.response.findFirstOrThrow({
      where: { formId },
      orderBy: { submittedAt: 'desc' },
      select: { editToken: true },
    });
    expect(row.editToken).not.toBeNull();
    return row.editToken ?? '';
  }

  const ownerOf = async (ref: string): Promise<string | null> =>
    (await app().prisma.file.findUniqueOrThrow({ where: { publicRef: ref } }))
      .responseId;

  it('claims what a submission names — the round trip', async () => {
    const file = await upload('Nachweis.pdf');
    expect(await ownerOf(file.ref)).toBeNull();

    const submitted = await submit(answerWith([file]));
    expect(submitted.status).toBe(200);
    expect(await ownerOf(file.ref)).not.toBeNull();

    // The stored answer names the file by reference **and** by name — the copy
    // the export and the responses table render from (ADR-0014 no. 17).
    const stored = await app().prisma.response.findFirstOrThrow({
      where: { formId },
      orderBy: { submittedAt: 'desc' },
      select: { answers: true },
    });
    expect(stored.answers).toMatchObject({
      [NACHWEIS]: { files: [{ ref: file.ref, name: 'Nachweis.pdf' }] },
    });
  });

  /**
   * **The name in the answer is a checked copy, not a trusted one.**
   *
   * A submission that repeats a name the row does not carry is refused, because
   * the alternative is an organisation reading a link labelled „Vollmacht.pdf" over
   * bytes whose download arrives as something else: `Content-Disposition` is
   * built from the row (no. 10), so the two would simply disagree.
   *
   * *Reproduction:* drop the `row.file_name !== file.name` check from
   * `claimAttachments` → this is red.
   */
  it('refuses a submission that renames somebody’s file on the way in', async () => {
    const file = await upload('Nachweis.pdf');

    const refused = await submit(
      answerWith([{ ref: file.ref, fileName: 'Vollmacht.pdf' }]),
    );

    expect(refused.status).toBe(409);
    expect((refused.body as { reason: string }).reason).toBe(
      'attachment_unavailable',
    );
    expect(await ownerOf(file.ref)).toBeNull();
  });

  /**
   * **The trap this file exists to catch.**
   *
   * *Reproduction:* remove the `releaseAttachments` call from the edit
   * transaction → the file keeps its `response_id`, the purge never
   * takes it, and this test is red on the last assertion.
   */
  it('lets go of an attachment a correction removed', async () => {
    const file = await upload('Alt.pdf');
    expect((await submit(answerWith([file]))).status).toBe(200);
    const token = await tokenOfLatest();
    const owner = await ownerOf(file.ref);
    expect(owner).not.toBeNull();

    const corrected = await writeEdit(token, answerWith([]));
    expect(corrected.status).toBe(200);

    // Without an owner it is what the purge of no. 15 selects; with one it is
    // invisible to every reader this application has.
    expect(await ownerOf(file.ref)).toBeNull();
  });

  /**
   * Removing one of two must not release the other — „alles, was diese Antwort
   * noch nennt, behält seinen Eigentümer" is the half a `DELETE`-everything
   * would get wrong, and it would be wrong in the expensive direction: a stored
   * answer pointing at bytes the purge takes a day later.
   */
  it('keeps the attachment a correction still names', async () => {
    const kept = await upload('Bleibt.pdf');
    const dropped = await upload('Geht.pdf');
    expect((await submit(answerWith([kept, dropped]))).status).toBe(200);
    const token = await tokenOfLatest();

    expect((await writeEdit(token, answerWith([kept]))).status).toBe(200);

    expect(await ownerOf(kept.ref)).not.toBeNull();
    expect(await ownerOf(dropped.ref)).toBeNull();
  });

  /**
   * The second half of the edit story: a correction can also **add** a file,
   * and it uploads through a door of its own — the edit token's, which runs the
   * edit refusal chain rather than the submission's.
   */
  it('claims an attachment a correction added through the edit route', async () => {
    const first = await upload('Erst.pdf');
    expect((await submit(answerWith([first]))).status).toBe(200);
    const token = await tokenOfLatest();

    const added = await uploadForEdit(token, 'Dann.pdf');
    expect(added.status).toBe(201);
    const second = added.body as Uploaded;

    expect((await writeEdit(token, answerWith([first, second]))).status).toBe(
      200,
    );

    expect(await ownerOf(second.ref)).not.toBeNull();
    expect(await ownerOf(second.ref)).toBe(await ownerOf(first.ref));
  });

  /**
   * **The handover, run end to end** (a review finding).
   *
   * „What a correction removes loses its owner" is only half a promise; the
   * other half is that something then takes it. Both halves are measured next
   * door — the release here, the predicate in `test/files/file-purge.spec.ts` —
   * and the composition follows from the purge's predicate being generic. But
   * the composition is what the requirement claims, so it is worth one case that
   * actually walks it: correct an answer, let the file age past the deadline,
   * run the purge, and find the bytes gone.
   *
   * The clock is the row's rather than the service's: `createdAt` is written
   * back to before the deadline, which is the same trick the purge suite uses
   * and needs no second calendar here.
   */
  it('hands a removed attachment to the purge, bytes and all', async () => {
    const file = await upload('Veraltet.pdf');
    expect((await submit(answerWith([file]))).status).toBe(200);
    const token = await tokenOfLatest();
    expect((await writeEdit(token, answerWith([]))).status).toBe(200);

    const row = await app().prisma.file.findUniqueOrThrow({
      where: { publicRef: file.ref },
    });
    expect(row.responseId).toBeNull();
    expect(storage.read(row.id)).toBeDefined();

    await app().prisma.file.update({
      where: { id: row.id },
      data: {
        createdAt: new Date(Date.now() - UNCLAIMED_FILE_LIFETIME_MS - 60_000),
      },
    });

    expect(await app().app.get(FilePurgeService).runOnce()).toBe(1);
    expect(storage.read(row.id)).toBeUndefined();
    expect(
      await app().prisma.file.findUnique({ where: { id: row.id } }),
    ).toBeNull();
  });

  /**
   * **A correction gives its waiting room back, and one address may correct
   * more than twice** (found independently, in two separate reviews).
   *
   * The claim is only half the bookkeeping. The other half lives in process
   * memory — `upload-quota.ts` counts what an address has uploaded and *not*
   * yet had claimed, and the submission path gives that allowance back after
   * its commit. The edit path claimed but never released, so every corrected
   * attachment kept occupying the room it had already left.
   *
   * It points the wrong way, which is why it is worth a case of its own: an
   * attacker is bounded by the hourly counters either way, while an office
   * behind one address — an organisation's secretary correcting registrations, exactly
   * the caller this application is built for — fills the room with their own
   * claimed files and is refused. Not for a moment: for up to a day.
   *
   * Measured in bytes rather than in files, because that needs three uploads
   * instead of twenty-one and twenty-one from one address would measure the
   * rate limit instead. **All three go through the edit door**, and that is not
   * incidental: the two doors count into different rooms (the submission's key
   * carries the slug, the edit route's carries the address alone), so a case
   * that opened with the submission's door would fill neither room past its
   * limit and would pass with the defect in place. It did, on the first
   * attempt — the reproduction below is what caught it.
   *
   * *Reproduction:* drop `releaseUploads(refsOf(attachments))` from
   * `storeEditWithMails` → the third correction's upload answers 413 and this
   * case is red.
   */
  it('gives the waiting room back when a correction claims its file', async () => {
    // One address for the whole case — the point of it. `ownAddress()` hands
    // out a fresh one per request, which is why nothing saw this.
    const office = '198.51.100.251';

    const uploadAsOffice = async (
      path: string,
      fileName: string,
    ): Promise<request.Response> =>
      request(app().server)
        .post(apiPath(path))
        .set('X-Forwarded-For', office)
        .set('Content-Type', 'application/octet-stream')
        .set('X-File-Name', encodeURIComponent(fileName))
        .send(pdf(MAX_ATTACHMENT_BYTES));

    // The answer to correct. Its own upload goes through the submission's door
    // and therefore into the other room, where it is of no interest here.
    const initial = await upload('Erst.pdf');
    expect((await submit(answerWith([initial]))).status).toBe(200);
    const token = await tokenOfLatest();

    for (const round of ['Scan-1.pdf', 'Scan-2.pdf']) {
      const uploaded = await uploadAsOffice(
        `/public/responses/${token}/files`,
        round,
      );
      expect(uploaded.status).toBe(201);
      expect(
        (await writeEdit(token, answerWith([uploaded.body as Uploaded])))
          .status,
      ).toBe(200);
    }

    // Two files of 10 MiB have been claimed, so the 25 MiB room holds nothing.
    // Without the release it holds 20 MiB, leaves 5, and this answers 413.
    const third = await uploadAsOffice(
      `/public/responses/${token}/files`,
      'Scan-3.pdf',
    );
    expect(third.status).toBe(201);
  });

  /**
   * The edit route's own 404 covers its upload as well: a token that names
   * nothing must not be able to write bytes against a form it cannot name
   * either. Byte-identical to every other „gibt es nicht" of the public routes
   *  — it is the same `loadForEdit`.
   */
  it('refuses an upload behind a token that names nothing', async () => {
    const before = await app().prisma.file.count();

    const refused = await uploadForEdit(
      randomBytes(16).toString('base64url'),
      'Fremd.pdf',
    );

    expect(refused.status).toBe(404);
    expect(await app().prisma.file.count()).toBe(before);
  });
});
