import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import request from 'supertest';
import {
  submitResponseResponseSchema,
  uploadedFileSchema,
} from '@formsache/shared';
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
import { createTenant, type TenantFixture } from '../support/fixtures';
import { InMemoryFileStorage } from '../support/in-memory-file-storage';

/**
 * **The operations scripts upload the way the route demands — measured against
 * the route, not against a double** .
 *
 * ## Why this file exists
 *
 * `scripts/smoke.sh` and `scripts/restore-drill.sh` are the two scripts that
 * touch a *real* installation: the smoke test after every release and the
 * restore drill. Both uploaded an attachment — and both did it wrongly for
 * three CI runs, in the same way:
 *
 * ```
 * curl -F "file=@anlage.txt;type=text/plain" …/files
 * ```
 *
 * That violates **all three** conditions of the route at once (ADR-0014 no. 5
 * and no. 14): `multipart/form-data` instead of `application/octet-stream`, no
 * `x-file-name`, and a content whose signature is on no allowlist. None of the
 * script tests noticed it, because their double accepted every body — **a
 * double that is more lenient than the original measures the leniency of the
 * double.** It came to light only in the `stack` job, and there as „the
 * attachment came back changed": the `.ref` helper turned the missing field
 * into the string `"undefined"`, and the smoke test then fetched
 * `/api/responses/files/undefined`.
 *
 * ## What this file does differently
 *
 * It does **not** check whether certain words appear in the script. It reads
 * the shape of the upload out of the script — content type, file name, bytes —
 * and **drives the shipped route with it**. A script that swings back to
 * multipart turns this file red without anyone having to write the condition
 * down a second time.
 *
 * *Reproduction:* replace `--data-binary` with `-F` in the script → the shape
 * can no longer be read off, and the test fails at exactly that point.
 */

const ROOT = resolve(process.cwd(), '..', '..');

/** The shape of an upload as a script sends it. */
interface UploadShape {
  readonly contentType: string;
  readonly fileName: string;
  readonly body: Buffer;
}

/**
 * The `curl` call that uploads the file — together with its continuation
 * lines.
 *
 * No general shell parser: what is looked for is the one command whose target
 * ends in `/files`. If none is found, that is a finding and not an empty set —
 * which is why the function throws instead of giving `null`.
 */
function uploadCommand(script: string): string {
  const commands = script.match(/curl(?:[^\n\\]|\\\n)*/g) ?? [];
  const [first, ...rest] = commands.filter((command) =>
    command.includes('/files"'),
  );
  if (first === undefined || rest.length > 0) {
    throw new Error(
      `erwartet war genau ein Upload-Aufruf, gefunden: ${String(
        rest.length + (first === undefined ? 0 : 1),
      )}`,
    );
  }
  return first;
}

/** The value of a simple `NAME='wert'` assignment in the script. */
function assignment(script: string, name: string): string {
  const match = new RegExp(`^${name}='([^']*)'`, 'm').exec(script);
  if (match?.[1] === undefined) {
    throw new Error(`die Zuweisung ${name}=… fehlt im Skript`);
  }
  return match[1];
}

function shapeOf(relativePath: string): UploadShape {
  const script = readFileSync(resolve(ROOT, relativePath), 'utf8');
  const command = uploadCommand(script);

  // The bytes: the script creates them from a base64 constant, and exactly
  // these bytes go to the route here.
  const body = Buffer.from(assignment(script, 'ATTACHMENT_BASE64'), 'base64');
  const fileName = assignment(script, 'ATTACHMENT_NAME');

  const contentType = /-H 'content-type: ([^']+)'/.exec(command)?.[1];
  if (contentType === undefined) {
    throw new Error(
      'der Upload-Aufruf setzt keinen content-type — sendet er wieder multipart?',
    );
  }
  if (!command.includes('-H "x-file-name: $ATTACHMENT_NAME"')) {
    throw new Error('der Upload-Aufruf schickt den Dateinamen nicht mit');
  }
  if (!/--data-binary "@[^"]*\$ATTACHMENT_NAME"/.test(command)) {
    throw new Error('der Upload-Aufruf sendet die Datei nicht als rohen Rumpf');
  }

  return { contentType, fileName, body };
}

/**
 * The name the submission claims must be the one of the upload:
 * `claimAttachments` rejects a response whose name does not match the one the
 * server measured at upload time. Two spellings of the same name in the script
 * would be exactly the rejection that one only sees on a real installation.
 */
function claimsSameName(relativePath: string): boolean {
  const script = readFileSync(resolve(ROOT, relativePath), 'utf8');
  return script.includes(String.raw`\"name\":\"$ATTACHMENT_NAME\"`);
}

/**
 * **The status the script expects from the submission — read out of the
 * script, not written down here a second time.**
 *
 * This route carries `@HttpCode(HttpStatus.OK)`, so it answers **200** where a
 * `POST` in NestJS would otherwise give 201. Both scripts stood on 201 for one
 * attempt — on the default, not on the contract —, and the double in
 * `smoke.test.sh` likewise: again two sides that agreed with each other, and
 * again it came to light only on the real stack.
 *
 * A constant `200` at this point would have been the **third** spelling of the
 * same number. The test instead reads it out of the line that counts in
 * operation, and holds it against what the shipped route really answers.
 */
function expectedSubmitStatus(relativePath: string): number {
  const script = readFileSync(resolve(ROOT, relativePath), 'utf8');
  const match = /\[ "\$submit_status" = '(\d{3})' \]/.exec(script);
  if (match?.[1] === undefined) {
    throw new Error(
      'das Skript prüft den Status der Einreichung nicht — sucht es wieder nach einem Feld?',
    );
  }
  return Number(match[1]);
}

const SCRIPTS = ['scripts/smoke.sh', 'scripts/restore-drill.sh'];

const PAGE = '019ff400-0000-7000-8000-0000000000f0';
const NACHWEIS = '019ff400-0000-7000-8000-0000000000f2';

const definition = {
  pages: [
    {
      id: PAGE,
      title: 'Seite',
      questions: [
        {
          id: NACHWEIS,
          type: 'file',
          label: 'Nachweis',
          hint: null,
          required: true,
          width: 'full',
          maxFiles: 1,
        },
      ],
    },
  ],
};

describe('Die Betriebsskripte laden hoch, wie die Route es verlangt ', () => {
  let database: TestDatabase;
  let testApp: TestApp;
  let tenant: TenantFixture;
  let slug: string;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      storage: new InMemoryFileStorage(),
    });

    tenant = await createTenant(testApp.prisma, 'SCRIPTS');
    slug = randomBytes(16).toString('base64url');
    const form = await testApp.prisma.form.create({
      data: {
        tenantId: tenant.id,
        title: 'Anlage aus dem Skript',
        draftSchema: definition,
        publicSlug: slug,
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
      data: { publishedVersionId: version.id },
    });
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database.release();
  }, 120_000);

  for (const path of SCRIPTS) {
    it(`${path}: die gesendete Gestalt wird angenommen`, async () => {
      const shape = shapeOf(path);

      const response = await request(testApp.server)
        .post(apiPath(`/public/forms/${slug}/files`))
        .set('content-type', shape.contentType)
        .set('x-file-name', encodeURIComponent(shape.fileName))
        .send(shape.body);

      expect(response.status).toBe(201);
      const accepted = uploadedFileSchema.parse(response.body);
      // Exactly the field the helper in the script reads out — were it
      // missing, it would turn it into `"undefined"` and the run would
      // seemingly go on.
      expect(accepted.ref).not.toBe('');
      expect(accepted.fileName).toBe(shape.fileName);
    });

    it(`${path}: die Einreichung beansprucht denselben Dateinamen`, () => {
      expect(claimsSameName(path)).toBe(true);
    });

    it(`${path}: die Einreichung antwortet mit dem erwarteten Status`, async () => {
      const shape = shapeOf(path);
      const uploaded = uploadedFileSchema.parse(
        (
          await request(testApp.server)
            .post(apiPath(`/public/forms/${slug}/files`))
            .set('content-type', shape.contentType)
            .set('x-file-name', encodeURIComponent(shape.fileName))
            .send(shape.body)
        ).body,
      );

      const response = await request(testApp.server)
        .post(apiPath(`/public/forms/${slug}/responses`))
        .send({
          answers: {
            [NACHWEIS]: {
              files: [{ ref: uploaded.ref, name: uploaded.fileName }],
            },
          },
        });

      expect(response.status).toBe(expectedSubmitStatus(path));
      // And the field by which the script recognises the acceptance — the
      // same one the old check (`"id"`) would never have found. Parsed through
      // the shared schema, not eyed up with `toMatchObject`: what arrives here
      // must be the confirmation document and nothing that resembles it.
      const confirmation = submitResponseResponseSchema.parse(response.body);
      expect(confirmation.confirmationTitle).not.toBe('');
    });
  }

  /**
   * The counter-check, **executed instead of claimed**: the old shape against
   * the same route. Without it the case above would only prove that something
   * or other gets through.
   */
  it('die alte Gestalt — multipart mit Klartext — wird abgewiesen', async () => {
    const response = await request(testApp.server)
      .post(apiPath(`/public/forms/${slug}/files`))
      .attach('file', Buffer.from('Klartext, kein Bild.\n'), 'anlage.txt');

    expect(response.status).toBe(415);
  });
});
