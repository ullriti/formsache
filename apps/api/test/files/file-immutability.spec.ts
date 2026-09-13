import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { createTestApp, type TestApp } from '../support/create-test-app';
import { createTenant, type TenantFixture } from '../support/fixtures';

/**
 * **The `BEFORE UPDATE` trigger of ADR-0014 no. 3, measured in the database**.
 *
 * The `CHECK` pins a row *shape*, and a `CHECK` is evaluated on the row
 * as it looks **afterwards** — on every `UPDATE` too. So one statement turns a
 * foreign attachment into a Logo, satisfies the constraint completely, and
 * produces exactly the row it was written against: one that the public,
 * session-less logo route of no. 11(a) hands to anybody who asks.
 *
 * The rows here are written and rewritten with **raw SQL**, deliberately: the
 * claim is about the database, not about a service. „Die Anwendung schreibt so
 * etwas nie" is the reason this is cheap to forbid, never the reason it cannot
 * happen — a seed, a migration or a future second writer are the callers this
 * is for.
 *
 * *Reproduction:* drop the trigger (`DROP TRIGGER "file_immutable_columns" ON
 * "file"`) → the first two assertions below go green in the wrong direction,
 * i.e. the statements succeed. Measured, not assumed.
 */
describe('a file row cannot be rewritten into another kind (ADR-0014 Nr. 3)', () => {
  let database: TestDatabase;
  let testApp: TestApp;
  let prisma: PrismaService;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaForm: string;
  let betaForm: string;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
    prisma = testApp.prisma;

    alpha = await createTenant(prisma, 'ALPHA');
    beta = await createTenant(prisma, 'BETA');
    alphaForm = (
      await prisma.form.create({
        data: {
          tenantId: alpha.id,
          title: 'Anmeldung',
          draftSchema: { pages: [] },
          publicSlug: 'slug-immutable-alpha',
        },
      })
    ).id;
    betaForm = (
      await prisma.form.create({
        data: {
          tenantId: beta.id,
          title: 'Anmeldung',
          draftSchema: { pages: [] },
          publicSlug: 'slug-immutable-beta',
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database.release();
  }, 120_000);

  const attachment = async (): Promise<string> =>
    (
      await prisma.file.create({
        data: {
          tenantId: alpha.id,
          kind: 'response_attachment',
          formId: alphaForm,
          publicRef: randomUUID(),
          fileName: 'Nachweis.pdf',
          contentType: 'application/pdf',
          status: 'stored',
          byteSize: 1024,
        },
        select: { id: true },
      })
    ).id;

  /**
   * **The statement the ADR writes out**, verbatim. It satisfies
   * `file_kind_shape` — and it is the one this stage exists to make impossible.
   */
  it('refuses the rewrite that would push an attachment into the logo route', async () => {
    const id = await attachment();

    await expect(
      prisma.$executeRaw`
        UPDATE "file"
           SET "kind" = 'tenant_logo', "form_id" = NULL, "response_id" = NULL
         WHERE "id" = ${id}::uuid`,
    ).rejects.toThrow(/immutable/i);

    const row = await prisma.file.findUniqueOrThrow({ where: { id } });
    expect(row.kind).toBe('response_attachment');
    expect(row.formId).toBe(alphaForm);
  });

  it('refuses moving a file to another organisation or another form', async () => {
    const id = await attachment();

    await expect(
      prisma.$executeRaw`
        UPDATE "file" SET "tenant_id" = ${beta.id}::uuid WHERE "id" = ${id}::uuid`,
    ).rejects.toThrow(/immutable/i);

    await expect(
      prisma.$executeRaw`
        UPDATE "file" SET "form_id" = ${betaForm}::uuid WHERE "id" = ${id}::uuid`,
    ).rejects.toThrow(/immutable/i);

    const row = await prisma.file.findUniqueOrThrow({ where: { id } });
    expect(row.tenantId).toBe(alpha.id);
    expect(row.formId).toBe(alphaForm);
  });

  /**
   * The three columns the application *does* write after the row exists
   * (no. 4, no. 13). The trigger has to leave them alone, or claiming and
   * „stored" would both fail — a lock that also locks the door it guards.
   */
  it('leaves response_id, status and byte_size writable', async () => {
    const id = await attachment();
    const response = await prisma.response.create({
      data: {
        tenantId: alpha.id,
        formId: alphaForm,
        formVersionId: (
          await prisma.formVersion.create({
            data: {
              tenantId: alpha.id,
              formId: alphaForm,
              version: 1,
              schema: { pages: [] },
            },
          })
        ).id,
        answers: {},
      },
      select: { id: true },
    });

    await expect(
      prisma.file.update({
        where: { id },
        data: {
          responseId: response.id,
          status: 'stored',
          byteSize: 2048,
        },
      }),
    ).resolves.toMatchObject({ responseId: response.id, byteSize: 2048 });
  });
});
