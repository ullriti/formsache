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
 * **The `file` model against real PostgreSQL — and above all the `CHECK`
 * constraint, which is hand-written SQL** (ADR-0014 no. 3).
 *
 * Prisma cannot express a `CHECK`, so the constraint lives in the migration
 * and is invisible to the schema diff. Nothing else in this repository would
 * notice if it were dropped, mistyped or applied to the wrong column: the
 * application never writes a row that violates it, which is precisely the
 * point — and precisely why „es ist ja im Migrations-SQL" is not evidence. The
 * evidence is a write that has to fail.
 *
 * The rows are written through Prisma rather than through a service, because
 * there is no service yet (the upload path is not built yet) and because the claim of
 * no. 3 is about the **database**: a state the application cannot produce must
 * not be reachable past it either.
 */
describe('the file model and its shape constraint (ADR-0014 Nr. 3)', () => {
  let database: TestDatabase;
  let testApp: TestApp;
  let prisma: PrismaService;
  let tenant: TenantFixture;
  let formId: string;
  /** `form_version.version` is unique per form, so every fixture takes one. */
  let versionCounter = 10;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
    prisma = testApp.prisma;

    tenant = await createTenant(prisma, 'ALPHA');
    const form = await prisma.form.create({
      data: {
        tenantId: tenant.id,
        title: 'Anmeldung mit Nachweis',
        draftSchema: { pages: [] },
        publicSlug: 'slug-file-model',
      },
    });
    formId = form.id;
    // The same setup budget every other suite in this folder takes: acquiring a
    // database and booting the application is minutes on a loaded machine, and
    // Vitest's default hook timeout of ten seconds turns that into a failure
    // that reads like a defect in the code under test.
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database.release();
  }, 120_000);

  const attachment = () => ({
    tenantId: tenant.id,
    kind: 'response_attachment' as const,
    formId,
    publicRef: randomUUID(),
    fileName: 'Nachweis.pdf',
    contentType: 'application/pdf',
  });

  /**
   * One answer and one draft of the same form — the two owners of Konzept no. 82,
   * for the cases that measure what may hold a file at the same time.
   */
  async function ownersOfOneForm(): Promise<{
    responseId: string;
    draftId: string;
  }> {
    const version = await prisma.formVersion.create({
      data: {
        tenantId: tenant.id,
        formId,
        version: versionCounter++,
        schema: { pages: [] },
      },
    });
    const response = await prisma.response.create({
      data: {
        tenantId: tenant.id,
        formId,
        formVersionId: version.id,
        answers: {},
      },
    });
    const draft = await prisma.responseDraft.create({
      data: {
        tenantId: tenant.id,
        formId,
        formVersionId: version.id,
        token: randomUUID(),
        answers: {},
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    return { responseId: response.id, draftId: draft.id };
  }

  it('accepts the two shapes the application writes', async () => {
    const anlage = await prisma.file.create({ data: attachment() });
    expect(anlage.status).toBe('pending');
    // Null rather than 0 while nothing has been written: „wir wissen es nicht"
    // must not read as „eine leere Datei" when the per-answer total of no. 6
    // sums this column.
    expect(anlage.byteSize).toBeNull();
    expect(anlage.responseId).toBeNull();

    const logo = await prisma.file.create({
      data: {
        tenantId: tenant.id,
        kind: 'tenant_logo',
        publicRef: randomUUID(),
        fileName: 'logo.png',
        contentType: 'image/png',
      },
    });
    expect(logo.formId).toBeNull();
  });

  /**
   * The row somebody would write to push a foreign attachment into the
   * **public**, session-less Logo route (no. 11a). It is not a test anybody
   * can forget: it is a constraint violation.
   */
  it('refuses a tenant_logo that names an answer', async () => {
    await expect(
      prisma.file.create({
        data: {
          tenantId: tenant.id,
          kind: 'tenant_logo',
          publicRef: randomUUID(),
          fileName: 'logo.png',
          contentType: 'image/png',
          responseId: randomUUID(),
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses a tenant_logo that names a form', async () => {
    await expect(
      prisma.file.create({
        data: {
          tenantId: tenant.id,
          kind: 'tenant_logo',
          formId,
          publicRef: randomUUID(),
          fileName: 'logo.png',
          contentType: 'image/png',
        },
      }),
    ).rejects.toThrow(/file_kind_shape/);
  });

  /**
   * The other direction, and it carries more than tidiness: `form_id` is what
   * binds an attachment to an organisation (no. 13, condition 2), because `file` cannot
   * have the composite foreign key `response` has. An attachment without it
   * would be a row with no tenant floor at all.
   */
  it('refuses a response_attachment without a form', async () => {
    await expect(
      prisma.file.create({
        data: {
          tenantId: tenant.id,
          kind: 'response_attachment',
          publicRef: randomUUID(),
          fileName: 'Nachweis.pdf',
          contentType: 'application/pdf',
        },
      }),
    ).rejects.toThrow(/file_kind_shape/);
  });

  /**
   * **The second owner and the constraint that governs it** (the requirement).
   *
   * A logo with a draft is the same row as a logo with an answer — the row
   * with which somebody would push a foreign attachment into the public,
   * session-less logo route. The old constraint said nothing about `draft_id`,
   * so this hole was open again with the new column.
   */
  it('refuses a tenant_logo that names a draft', async () => {
    await expect(
      prisma.file.create({
        data: {
          tenantId: tenant.id,
          kind: 'tenant_logo',
          publicRef: randomUUID(),
          fileName: 'logo.png',
          contentType: 'image/png',
          draftId: randomUUID(),
        },
      }),
    ).rejects.toThrow(/file_kind_shape/);
  });

  /**
   * **Two owners on one row are refused by the database** — the reproduction
   * the requirement names („die `CHECK`-Bedingung weglassen").
   *
   * It is not a rule of tidiness but the mechanism underneath the handover of
   * the claim: submitting writes `response_id` and clears `draft_id` away in
   * **one** statement, and a version that forgets the second half fails here
   * instead of leaving behind a row about whose lifetime two retention periods
   * are of different opinions.
   *
   * Both ways are measured — `INSERT` **and** `UPDATE` — because a `CHECK`
   * examines the row as it looks *afterwards*: the handover is an `UPDATE`,
   * and that is the way on which the mistake would arise.
   */
  it('refuses a file owned by an answer and a draft at once', async () => {
    const { responseId, draftId } = await ownersOfOneForm();

    await expect(
      prisma.file.create({
        data: { ...attachment(), responseId, draftId },
      }),
    ).rejects.toThrow(/file_kind_shape/);

    const owned = await prisma.file.create({
      data: { ...attachment(), draftId },
    });
    await expect(
      prisma.file.update({
        where: { id: owned.id },
        // Exactly the `UPDATE` the claim does **not** write: the answer
        // added, the draft left standing.
        data: { responseId },
      }),
    ).rejects.toThrow(/file_kind_shape/);
  });

  /**
   * The opposite direction: the handover itself — answer added, draft cleared
   * away — is the shape that gets through. Without this case the one above
   * would only prove that the constraint refuses something.
   */
  it('accepts the handover from a draft to an answer', async () => {
    const { responseId, draftId } = await ownersOfOneForm();
    const owned = await prisma.file.create({
      data: { ...attachment(), draftId },
    });

    const claimed = await prisma.file.update({
      where: { id: owned.id },
      data: { responseId, draftId: null },
    });
    expect(claimed.responseId).toBe(responseId);
    expect(claimed.draftId).toBeNull();
  });

  /**
   * **`SET NULL` on the draft, as on the answer** — and for the same reason
   * (ADR-0014 no. 16): an expired draft must not take the row of its
   * attachment with it, or the bytes would be left lying on a volume that
   * nothing can enumerate. Without an owner the file is exactly what the purge
   * of no. 15 takes.
   */
  it('lets a draft go and leaves its files ownerless', async () => {
    const { draftId } = await ownersOfOneForm();
    const owned = await prisma.file.create({
      data: { ...attachment(), draftId },
    });

    await prisma.responseDraft.delete({ where: { id: draftId } });

    const orphan = await prisma.file.findUnique({ where: { id: owned.id } });
    expect(orphan).not.toBeNull();
    expect(orphan?.draftId).toBeNull();
  });

  /** The reference is an address; two rows must not share one. */
  it('keeps public_ref unique across the installation', async () => {
    const ref = randomUUID();
    await prisma.file.create({ data: { ...attachment(), publicRef: ref } });
    await expect(
      prisma.file.create({ data: { ...attachment(), publicRef: ref } }),
    ).rejects.toThrow();
  });

  /**
   * **The floor under ADR-0014 no. 16**, and the reason `form` is `NO ACTION`
   * rather than `Cascade`: deleting rows before their bytes leaves personal
   * data on a volume that nothing can find again, because the seam has no
   * `list()`. Whoever builds the trash removes the bytes and the
   * rows first — and until they do, the delete says so instead of succeeding
   * quietly.
   */
  it('refuses to delete a form that still has files', async () => {
    const doomed = await prisma.form.create({
      data: {
        tenantId: tenant.id,
        title: 'Formular mit Anlage',
        draftSchema: { pages: [] },
        publicSlug: 'slug-file-model-doomed',
      },
    });
    await prisma.file.create({
      data: { ...attachment(), formId: doomed.id },
    });

    await expect(
      prisma.form.delete({ where: { id: doomed.id } }),
    ).rejects.toThrow();
  });

  /**
   * And the counterpart, which is the opposite decision on purpose: a deleted
   * **answer** must not take its attachment rows with it. Losing the owner
   * turns the file into what the purge of no. 15 is for — unclaimed, and
   * physically deleted a day later, bytes first.
   */
  it('lets an answer go and leaves its files ownerless', async () => {
    const version = await prisma.formVersion.create({
      data: {
        tenantId: tenant.id,
        formId,
        version: 1,
        schema: { pages: [] },
      },
    });
    const response = await prisma.response.create({
      data: {
        tenantId: tenant.id,
        formId,
        formVersionId: version.id,
        answers: {},
      },
    });
    const claimed = await prisma.file.create({
      data: { ...attachment(), responseId: response.id },
    });

    await prisma.response.delete({ where: { id: response.id } });

    const orphan = await prisma.file.findUnique({ where: { id: claimed.id } });
    expect(orphan?.responseId).toBeNull();
  });
});
