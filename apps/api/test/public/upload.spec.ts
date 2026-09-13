import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { JSON_BODY_LIMIT_BYTES } from '../../src/app-setup';
import { MAX_ATTACHMENT_BYTES } from '@formsache/shared';

import { resetAddressFormAllowances } from '../../src/public/address-form-tracker';
import { PUBLIC_UPLOAD_RATE_LIMIT } from '../../src/public/public-forms.rate-limit';
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
import { InMemoryFileStorage } from '../support/in-memory-file-storage';

/**
 * **The upload endpoint — the requirements, every proof with its
 * reproduction** (ADR-0014 no. 5, 6, 7, 8, 14).
 *
 * The suite drives the shipped route with the shipped guards and holds the
 * **storage double**, because that is the one instrument the requirement names:
 * „gemessen am Storage-Doppel (welche Bytes es gesehen hat), nicht an einer
 * HTTP-Antwort — eine 413 sagt nichts darüber, was vorher auf die Platte lief."
 *
 * `TRUST_PROXY_HOPS: 1` plus a fresh `X-Forwarded-For` per test, for the reason
 * `submission-gate.spec.ts` states: the route allows ten uploads a minute per
 * address ⊕ form, and a suite that shares one address would be measuring the
 * rate limit instead of the thing under test. The limit itself is measured
 * deliberately, from **one** address, at the end.
 */

const PAGE = '019ff400-0000-7000-8000-0000000000a0';
const NAME = '019ff400-0000-7000-8000-000000000001';

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

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

describe('the public upload ', () => {
  let database: TestDatabase;
  let testApp: TestApp;
  let storage: InMemoryFileStorage;
  let tenant: TenantFixture;
  let slug: string;
  let formId: string;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    storage = new InMemoryFileStorage();
    testApp = await createTestApp({
      databaseUrl: database.url,
      env: { TRUST_PROXY_HOPS: 1 },
      storage,
    });

    tenant = await createTenant(testApp.prisma, 'UPLOAD');
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
    await testApp.prisma.form.update({
      where: { id: form.id },
      data: { publishedVersionId: version.id },
    });

    // The listener belongs to the suite, not to whichever request happened to
    // arrive first: `uploadChunked` speaks to it directly, and supertest would
    // otherwise close the server underneath it (the reason
    // `submission-gate.spec.ts` does the same).
    await new Promise<void>((resolve) => {
      testApp.server.listen(0, resolve);
    });
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database.release();
  }, 120_000);

  /**
   * Every „nichts wurde geschrieben" below is a **delta**, never an absolute
   * count: the double keeps what earlier tests stored, and an absolute zero
   * would only be true for whichever test happens to run first — the kind of
   * assertion that passes for the wrong reason.
   */
  let storedAtStart = 0;
  const storedSince = (): number => storage.size - storedAtStart;

  beforeEach(async () => {
    await testApp.prisma.file.deleteMany();
    storage.bytesSeen = 0;
    storedAtStart = storage.size;
  });

  afterEach(() => {
    // The quota and the per-address bookkeeping are module state, so one test's
    // uploads must not spend the next one's allowance.
    resetUploadQuota();
    resetAddressFormAllowances();
  });

  /**
   * The same request **without a `Content-Length`** — Node sends it chunked.
   *
   * Written against `node:http` rather than supertest because superagent sets
   * the header for a buffer body and there is no way to unset it. It goes to
   * the listener the suite opened in `beforeAll`, which is the same application.
   *
   * The response is resolved as soon as it arrives; an error on the *request*
   * afterwards is ignored on purpose, because that is the normal end of this
   * exchange — the server answered 413 while the body was still going up, and
   * whether the remainder is discarded or the socket is torn down is not what
   * this test is about.
   */
  const uploadChunked = (
    body: Buffer,
    options: { fileName?: string } = {},
  ): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const address = testApp.server.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      const call = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: apiPath(`/public/forms/${slug}/files`),
          headers: {
            'content-type': 'application/octet-stream',
            'x-file-name': encodeURIComponent(options.fileName ?? 'Gross.pdf'),
            'x-forwarded-for': ownAddress(),
          },
        },
        (answer) => {
          let text = '';
          answer.setEncoding('utf8');
          answer.on('data', (chunk: string) => (text += chunk));
          answer.on('end', () => {
            resolve({ status: answer.statusCode ?? 0, text });
          });
        },
      );
      let answered = false;
      call.on('response', () => (answered = true));
      call.on('error', (error) => {
        if (!answered) {
          reject(error);
        }
      });
      call.write(body);
      call.end();
    });

  /**
   * A second published form with a settings override, sealed through the
   * application's **own** service — the way an editor's save writes it, so the
   * document under test is one this server can read back.
   */
  const formWith = async (override: {
    overridden: Record<string, boolean>;
    values: Record<string, unknown>;
  }): Promise<string> => {
    const { SettingsSecretsService } =
      await import('../../src/settings/settings-secrets.service');
    const secrets = testApp.app.get(SettingsSecretsService);
    const ownSlug = randomBytes(16).toString('base64url');
    const form = await testApp.prisma.form.create({
      data: {
        tenantId: tenant.id,
        title: 'Anmeldung mit Nachweis',
        draftSchema: definition,
        publicSlug: ownSlug,
        status: 'active',
      },
    });
    const version = await testApp.prisma.formVersion.create({
      data: {
        tenantId: tenant.id,
        formId: form.id,
        version: 1,
        schema: definition,
      },
    });
    await testApp.prisma.form.update({
      where: { id: form.id },
      data: {
        publishedVersionId: version.id,
        settingsOverride: secrets.sealFormOverride(
          override as never,
          tenant.id,
          form.id,
        ),
      },
    });
    return ownSlug;
  };

  const upload = (
    body: Buffer,
    options: {
      fileName?: string;
      contentType?: string;
      address?: string;
      target?: string;
    } = {},
  ) => {
    const call = request(testApp.server)
      .post(apiPath(`/public/forms/${options.target ?? slug}/files`))
      .set('X-Forwarded-For', options.address ?? ownAddress())
      .set('Content-Type', options.contentType ?? 'application/octet-stream');
    const name = options.fileName ?? 'Nachweis.pdf';
    return call.set('X-File-Name', encodeURIComponent(name)).send(body);
  };

  /** the evidence: an allowed file goes through. */
  it('accepts a PDF and stores what it measured, not what it was told', async () => {
    const bytes = pdf(1024);
    const answer = await upload(bytes, { fileName: 'Nachweis Müller.pdf' });

    expect(answer.status).toBe(201);
    const body = answer.body as {
      ref: string;
      fileName: string;
      contentType: string;
      byteSize: number;
    };
    expect(body.contentType).toBe('application/pdf');
    expect(body.fileName).toBe('Nachweis Müller.pdf');
    expect(body.byteSize).toBe(bytes.length);

    const row = await testApp.prisma.file.findUniqueOrThrow({
      where: { publicRef: body.ref },
    });
    expect(row).toMatchObject({
      tenantId: tenant.id,
      formId,
      kind: 'response_attachment',
      // Derived from the signature, never from the caller (no. 5, no. 12).
      contentType: 'application/pdf',
      status: 'stored',
      byteSize: bytes.length,
      // Unclaimed until an answer claims it (no. 13).
      responseId: null,
    });
    // The storage key is the row's `id`, never the name and never the ref.
    expect(storage.read(row.id)?.equals(bytes)).toBe(true);
  });

  /**
   * **the evidence** — an allowed extension with foreign content.
   *
   * *Reproduction:* switch the check to the extension (`Nachweis.pdf` ends in
   * `.pdf`, so it would pass) → this goes red, and so does the SVG below.
   */
  it('refuses a file whose name says PDF and whose content says otherwise', async () => {
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(60),
    ]);
    const answer = await upload(zip, { fileName: 'Nachweis.pdf' });

    expect(answer.status).toBe(415);
    expect(await testApp.prisma.file.count()).toBe(0);
    // Nothing reached the storage: the signature is checked before the row
    // exists and long before anything is written (no. 4).
    expect(storedSince()).toBe(0);
  });

  /** **the evidence** — an SVG, declared `image/png` and named `.png`. */
  it('refuses an SVG even when it is declared and named as a PNG', async () => {
    const answer = await upload(SVG, {
      fileName: 'logo.png',
      // The declared type is *also* wrong on this route — it has to be
      // octet-stream — so the declaration is made a second way: the `X-File-Name`
      // says PNG and the content says SVG.
    });

    expect(answer.status).toBe(415);
    expect(await testApp.prisma.file.count()).toBe(0);
    expect(storedSince()).toBe(0);
  });

  /**
   * **the evidence** — the refusal names the reason readably and nothing else.
   *
   * No path, no storage key, no internal category: assumption A1 of the ADR says a
   * volume's layout must not travel outwards through an error.
   */
  it('says why, in a sentence, without a path', async () => {
    const answer = await upload(SVG, { fileName: 'logo.svg' });
    const message = (answer.body as { message: string }).message;

    expect(message).toContain('PDF');
    expect(message).toContain('Inhalt');
    // The two things that must never appear.
    expect(message).not.toMatch(/[/\\]/);
    expect(message).not.toMatch(/tmp|storage|formsache-file/i);
  });

  /**
   * **the evidence, and the one the requirement calls out** — a file over the limit
   * does **not** land on the disk in full.
   *
   * **Sent without a `Content-Length`**, and that is the whole design of this
   * test. A declared length above the limit is refused before a byte is read
   * (the test below), so a suite that lets supertest set the header would be
   * measuring *that* shortcut and would stay green with no streaming counter at
   * all — measured: with the limit moved behind the receipt this file passed
   * ten of ten until the header was removed. Chunked transfer means the counter
   * is the only thing between the caller and the disk, which is what „eine
   * Grenze, die erst nach dem vollständigen Empfang greift, ist keine" is about.
   *
   * Measured at the double: `bytesSeen` counts what the storage was *handed*,
   * including what it then refused to keep. A 413 says nothing about that.
   *
   * *Reproduction:* hand `put()` an unbounded `maxBytes` and check the size
   * afterwards → `bytesSeen` becomes the whole body and this goes red while the
   * status stays 413.
   */
  it('tears the write down at the limit instead of after it', async () => {
    // **Three times the limit**, not one byte over it, and that is a deliberate
    // number: the counter aborts on the chunk that crosses the line, so
    // „bytesSeen ≤ Grenze" is not true to the byte — with a body one kilobyte
    // over, the last chunk carries exactly that kilobyte and the assertion
    // could not tell a working limit from a missing one. Thirty megabytes make
    // the difference between „abgebrochen" and „alles gelesen" unmistakable.
    const tooBig = Buffer.concat([
      pdf(64),
      randomBytes(MAX_ATTACHMENT_BYTES * 3 - 64),
    ]);
    const CHUNK_SLACK = 1024 * 1024;

    const answer = await uploadChunked(tooBig);

    expect(answer.status).toBe(413);
    expect(answer.text).toContain('zu groß');
    // The point of the whole test: the storage never saw the whole file.
    expect(storage.bytesSeen).toBeLessThan(MAX_ATTACHMENT_BYTES + CHUNK_SLACK);
    expect(storage.bytesSeen).toBeLessThan(tooBig.length / 2);
    // And it kept nothing — neither bytes nor a row that claims to have some.
    expect(storedSince()).toBe(0);
    expect(await testApp.prisma.file.count()).toBe(0);
  });

  /**
   * The courtesy in front of the counter: a declared length above the limit is
   * refused **before a byte is read**.
   *
   * It is not the mechanism — a caller who omits or forges the header meets the
   * counter above — but it is what keeps an honest client from pushing ten
   * megabytes up a mobile connection to be told no at the end.
   */
  it('refuses an oversized declared length without reading the body', async () => {
    const tooBig = Buffer.concat([
      pdf(64),
      randomBytes(MAX_ATTACHMENT_BYTES + 1024 - 64),
    ]);

    // supertest sets `Content-Length` for a buffer, which is exactly the case
    // under test here.
    const answer = await upload(tooBig);

    expect(answer.status).toBe(413);
    expect(storage.bytesSeen).toBe(0);
    expect(await testApp.prisma.file.count()).toBe(0);
  });

  /**
   * **ADR-0014 no. 14 and assumption A6, measured rather than believed.**
   *
   * A body larger than the JSON parser's limit has to arrive at the counter in
   * full instead of falling out of `express.json` with a 413 — that is what
   * „der Upload läuft nicht durch den JSON-Parser" means. The file below is
   * comfortably over `JSON_BODY_LIMIT_BYTES` and comfortably under the upload
   * limit.
   */
  it('does not travel through the JSON body parser', async () => {
    const big = pdf(JSON_BODY_LIMIT_BYTES * 3);
    const answer = await upload(big);

    expect(answer.status).toBe(201);
    expect((answer.body as { byteSize: number }).byteSize).toBe(big.length);
    expect(storage.bytesSeen).toBe(big.length);
  });

  /** ADR-0014 no. 14: a foreign HTML form cannot even address this route. */
  it('answers 415 to every request type but octet-stream', async () => {
    for (const contentType of [
      'multipart/form-data; boundary=x',
      'application/x-www-form-urlencoded',
      'text/plain',
      'application/json',
      'image/png',
    ]) {
      const answer = await upload(png(), { contentType });
      expect(answer.status, contentType).toBe(415);
    }
    expect(await testApp.prisma.file.count()).toBe(0);
  });

  it('refuses a file name that is a path, and does not clean it up', async () => {
    const answer = await upload(png(), { fileName: '../../etc/passwd' });
    expect(answer.status).toBe(400);
    expect(await testApp.prisma.file.count()).toBe(0);
  });

  /**
   * **The upload runs the submission's own refusal chain** (`openForUpload`).
   *
   * Both of these are refusals a *stranger* meets, and both write nothing: bytes
   * are not stored against a registration that is not accepting any, and
   * somebody who has not passed the password gate learns only that the gate is
   * there — not whether the form is open, closed or full.
   *
   * *Reproduction:* drop the `openForUpload` call and take the form with a plain
   * lookup → both go red (201 instead of 409) while every other test stays green.
   */
  it('refuses an upload to a form behind the password gate', async () => {
    const protectedForm = await formWith({
      overridden: {
        access: true,
        confirm: false,
        display: false,
        budget: false,
      },
      values: { passwordEnabled: true, password: 'Jahrestagung2026' },
    });

    const answer = await upload(png(), { target: protectedForm });

    expect(answer.status).toBe(409);
    expect((answer.body as { reason: string }).reason).toBe(
      'password_required',
    );
    expect(await testApp.prisma.file.count()).toBe(0);
    expect(storedSince()).toBe(0);
  });

  it('refuses an upload to a form whose deadline has passed', async () => {
    const closed = await formWith({
      overridden: {
        access: false,
        confirm: false,
        display: false,
        budget: false,
      },
      // The whole section, because an overridden section is stored complete —
      // a partial one does not parse, and an unparseable settings document is
      // *fail closed* (503) rather than „offen".
      values: {
        openEnabled: true,
        openAt: null,
        closeAt: new Date(Date.now() - 60_000).toISOString(),
        timeLimitEnabled: false,
        timeLimitMin: 30,
        maxResponsesEnabled: false,
        maxResponses: 100,
      },
    });

    const answer = await upload(pdf(), { target: closed });

    expect(answer.status).toBe(409);
    expect((answer.body as { reason: string }).reason).toBe('closed');
    expect(await testApp.prisma.file.count()).toBe(0);
    expect(storedSince()).toBe(0);
  });

  it('answers the public 404 for an address that names no form', async () => {
    const answer = await upload(png(), { target: randomUUID() });
    expect(answer.status).toBe(404);
    expect(storedSince()).toBe(0);
  });

  /**
   * **The requirement, third proof** — the limit is keyed address ⊕ form, never
   * form-wide.
   *
   * Both halves are measured, and the second is the one that matters: a caller
   * who spent their allowance must **not** have spent anybody else's, or the
   * counter is the lever with which a stranger switches off an organisation's
   * registration.
   *
   * *Reproduction:* key the throttler on the slug alone → the second address
   * meets a 429 and the last assertion goes red.
   */
  it('throttles one address on one form without touching another address', async () => {
    const mine = ownAddress();
    const statuses: number[] = [];
    for (let i = 0; i <= PUBLIC_UPLOAD_RATE_LIMIT.limit; i += 1) {
      const answer = await upload(png(), { address: mine });
      statuses.push(answer.status);
    }

    expect(statuses.filter((status) => status === 201)).toHaveLength(
      PUBLIC_UPLOAD_RATE_LIMIT.limit,
    );
    expect(statuses.at(-1)).toBe(429);

    // Somebody else, same form, same moment: unaffected.
    const other = await upload(png(), { address: ownAddress() });
    expect(other.status).toBe(201);
  });
});
