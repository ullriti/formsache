import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_FILES_PER_RESPONSE,
  MAX_RESPONSE_BYTES,
  UNCLAIMED_FILE_LIFETIME_MS,
} from '@formsache/shared';

import {
  CLAIM_REFUSAL,
  ClaimRefusedError,
  claimAttachments,
} from '../../src/public/attachment-claim';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { createTestApp, type TestApp } from '../support/create-test-app';
import { createTenant, type TenantFixture } from '../support/fixtures';

/**
 * **Claiming — the five conditions of ADR-0014 no. 13 and the two per-answer
 * limits of no. 6** .
 *
 * Each condition has its own reproduction, and the ADR is explicit that without
 * one none of them counts as built: *remove the condition → the test that tries
 * the forbidden case goes red*. They are listed in the review report with what
 * each one measured.
 *
 * The setup for condition 2 is the only one that needs a row written **past the
 * API**: a `file` with `form_id` of Organisation A and `tenant_id` of Organisation B, exactly
 * as a raw write, a seed or a future second writer would leave it. It is
 * expressible because `file` has no composite foreign key (Prisma requires
 * every scalar of an optional relation to be optional, and `tenant_id` is
 * required) — which is why condition 2 stands on its own instead of „coming
 * with" `form_id`, and why this file is the load-bearing proof of the stage
 * rather than one of many.
 *
 * The claim is exercised **inside a transaction**, the way the submission runs
 * it, and never against the plain client: claiming outside the answer's
 * transaction is the shape no. 13 rules out.
 */
/** The name every fixture row carries — the one a claim has to repeat. */
const FIXTURE_NAME = 'Nachweis.pdf';

describe('claiming a submission’s attachments (ADR-0014 Nr. 13)', () => {
  let database: TestDatabase;
  let testApp: TestApp;
  let prisma: PrismaService;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaForm: string;
  let alphaOtherForm: string;
  let betaForm: string;
  let alphaVersion: string;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
    prisma = testApp.prisma;

    alpha = await createTenant(prisma, 'ALPHA');
    beta = await createTenant(prisma, 'BETA');
    alphaForm = await createForm(alpha.id, 'claim-alpha');
    alphaOtherForm = await createForm(alpha.id, 'claim-alpha-other');
    betaForm = await createForm(beta.id, 'claim-beta');
    alphaVersion = (
      await prisma.formVersion.create({
        data: {
          tenantId: alpha.id,
          formId: alphaForm,
          version: 1,
          schema: { pages: [] },
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database.release();
  }, 120_000);

  async function createForm(tenantId: string, slug: string): Promise<string> {
    const form = await prisma.form.create({
      data: {
        tenantId,
        title: 'Anmeldung',
        draftSchema: { pages: [] },
        publicSlug: slug,
      },
    });
    return form.id;
  }

  /** A stored attachment, by default a well-formed one of Organisation ALPHA. */
  async function file(
    overrides: {
      tenantId?: string;
      formId?: string;
      kind?: 'response_attachment' | 'tenant_logo';
      createdAt?: Date;
      byteSize?: number | null;
      responseId?: string;
    } = {},
  ): Promise<string> {
    const ref = randomBytes(16).toString('base64url');
    const isLogo = overrides.kind === 'tenant_logo';
    await prisma.file.create({
      data: {
        tenantId: overrides.tenantId ?? alpha.id,
        kind: overrides.kind ?? 'response_attachment',
        formId: isLogo ? null : (overrides.formId ?? alphaForm),
        publicRef: ref,
        fileName: FIXTURE_NAME,
        contentType: 'application/pdf',
        status: 'stored',
        byteSize: overrides.byteSize === undefined ? 1024 : overrides.byteSize,
        ...(overrides.createdAt === undefined
          ? {}
          : { createdAt: overrides.createdAt }),
        ...(overrides.responseId === undefined
          ? {}
          : { responseId: overrides.responseId }),
      },
    });
    return ref;
  }

  /** An answer of ALPHA on `alphaForm`, the owner a claim writes. */
  async function response(): Promise<string> {
    const row = await prisma.response.create({
      data: {
        tenantId: alpha.id,
        formId: alphaForm,
        formVersionId: alphaVersion,
        answers: {},
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Runs the claim the way the submission does — inside a transaction, with the
   * form and Organisation of the *resolved* form, never of the caller.
   */
  async function claim(
    refs: string[],
    options: {
      formId?: string;
      tenantId?: string;
      now?: Date;
      /** The name the submission claims to have — `FIXTURE_NAME` unless said otherwise. */
      name?: string;
    } = {},
  ): Promise<void> {
    const responseId = await response();
    await prisma.$transaction(async (tx) => {
      await claimAttachments(tx, {
        files: refs.map((ref) => ({
          ref,
          name: options.name ?? FIXTURE_NAME,
        })),
        formId: options.formId ?? alphaForm,
        tenantId: options.tenantId ?? alpha.id,
        responseId,
        now: options.now ?? new Date(),
      });
    });
  }

  const refusalOf = async (run: Promise<void>): Promise<string | undefined> => {
    try {
      await run;
      return undefined;
    } catch (error) {
      return error instanceof ClaimRefusedError ? error.refusal : 'other';
    }
  };

  it('claims a file of this form and this organisation', async () => {
    const ref = await file();
    await claim([ref]);

    const row = await prisma.file.findUniqueOrThrow({
      where: { publicRef: ref },
    });
    expect(row.responseId).not.toBeNull();
  });

  /** Condition 1 — already claimed. *Reproduction:* drop `response_id IS NULL`. */
  it('refuses a file a previous submission already claimed', async () => {
    const ref = await file();
    await claim([ref]);
    const owner = (
      await prisma.file.findUniqueOrThrow({ where: { publicRef: ref } })
    ).responseId;

    expect(await refusalOf(claim([ref]))).toBe(CLAIM_REFUSAL.unavailable);
    // And the first owner still owns it — a refused second claim must not move
    // the file, which is what a „letzter gewinnt" implementation would do.
    const row = await prisma.file.findUniqueOrThrow({
      where: { publicRef: ref },
    });
    expect(row.responseId).toBe(owner);
  });

  /**
   * **Condition 2 — the tenant boundary of this operation.**
   *
   * The row is written past the API on purpose: `form_id` of ALPHA,
   * `tenant_id` of BETA. Without this condition the claim would succeed on the
   * strength of `form_id` alone, and the retrieval of no. 11(b) — which reads
   * through `tenant_id` — would hand the attachment to the editors of the
   * **wrong** Organisation.
   *
   * *Reproduction:* remove `tenant_id` from the `WHERE` → this goes red.
   */
  it('refuses a file whose tenant is another organisation, even with the right form', async () => {
    const ref = await file({ tenantId: beta.id, formId: alphaForm });

    expect(await refusalOf(claim([ref]))).toBe(CLAIM_REFUSAL.unavailable);
    const row = await prisma.file.findUniqueOrThrow({
      where: { publicRef: ref },
    });
    expect(row.responseId).toBeNull();

    // The ordinary foreign file — another organisation, another form — is refused too,
    // and by *both* conditions rather than by luck.
    const foreign = await file({ tenantId: beta.id, formId: betaForm });
    expect(await refusalOf(claim([foreign]))).toBe(CLAIM_REFUSAL.unavailable);
  });

  /**
   * Condition 3 — another form, **inside the same organisation**, where condition 2
   * says nothing. *Reproduction:* remove `form_id` from the `WHERE`.
   */
  it('refuses a file uploaded against another form of the same organisation', async () => {
    const ref = await file({ formId: alphaOtherForm });
    expect(await refusalOf(claim([ref]))).toBe(CLAIM_REFUSAL.unavailable);
  });

  /**
   * Condition 4 — a Logo does not become an attachment.
   *
   * **Its reproduction stayed green, and that is the honest answer** („‚Blieb
   * grün, weil …' ist eine zulässige Antwort und mehr wert als eine
   * behauptete rote"). Removing `kind = 'response_attachment'` from the `WHERE`
   * changes nothing here, because `file_kind_shape` forces `form_id IS NULL` on
   * a `tenant_logo` and condition 3 then refuses it anyway. The condition is
   * therefore **defence in depth against a change to that constraint** rather
   * than the thing that stops this row today — and a later change is scheduled to change
   * exactly that constraint (the `draft_id` arm of ADR-0014 no. 15). Whoever
   * touches it should expect this test to become the one that bites.
   */
  it('refuses a tenant logo', async () => {
    const ref = await file({ kind: 'tenant_logo' });
    expect(await refusalOf(claim([ref]))).toBe(CLAIM_REFUSAL.unavailable);
  });

  /**
   * **Condition 5 — older than the purge deadline.**
   *
   * Without it, claiming races the purge: the purge selects „ohne Eigentümer und
   * älter als 24 h", and in the gap between its selection and its `remove()`
   * the same row can be claimed — producing a submitted answer with an
   * attachment that has no bytes, discovered weeks later by an editor clicking
   * a link. With it, the submission is refused *readably* instead.
   *
   * *Reproduction:* remove `created_at > now − 24 h` → this goes red.
   */
  it('refuses a file older than the purge deadline', async () => {
    const ref = await file({
      createdAt: new Date(Date.now() - UNCLAIMED_FILE_LIFETIME_MS - 60_000),
    });
    expect(await refusalOf(claim([ref]))).toBe(CLAIM_REFUSAL.unavailable);

    // One minute on the young side of the deadline is claimed, so the test
    // above measures the cut and not „alte Zeilen gehen nie".
    const fresh = await file({
      createdAt: new Date(Date.now() - UNCLAIMED_FILE_LIFETIME_MS + 60_000),
    });
    await expect(claim([fresh])).resolves.toBeUndefined();
  });

  /**
   * **The edit path re-claims what the answer already owns** (ADR-0014 no. 13,
   * last paragraph) — and it must work on an attachment that is *old*.
   *
   * A correction re-sends the whole answer, so it names the files it already
   * has. If condition 1 refused those, every edit would answer „Anhang
   * abgelaufen"; if condition 5 were asked of them as well, every correction to
   * an answer older than a day would. The claimed file is not the purge's
   * business, so its age is not the claim's either.
   */
  it('re-claims an attachment this very answer already owns, at any age', async () => {
    const responseId = await response();
    const ref = await file({
      responseId,
      createdAt: new Date(Date.now() - UNCLAIMED_FILE_LIFETIME_MS * 30),
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await claimAttachments(tx, {
          files: [{ ref, name: FIXTURE_NAME }],
          formId: alphaForm,
          tenantId: alpha.id,
          responseId,
          now: new Date(),
        });
      }),
    ).resolves.toBeUndefined();

    const row = await prisma.file.findUniqueOrThrow({
      where: { publicRef: ref },
    });
    expect(row.responseId).toBe(responseId);
  });

  /** A refusal rolls the **answer** back, which is why it throws. */
  it('leaves neither the answer nor a partial claim behind', async () => {
    const good = await file();
    const foreign = await file({ tenantId: beta.id, formId: alphaForm });
    const responsesBefore = await prisma.response.count();

    const responseId = await response();
    const attempt = prisma.$transaction(async (tx) => {
      await claimAttachments(tx, {
        files: [good, foreign].map((ref) => ({ ref, name: FIXTURE_NAME })),
        formId: alphaForm,
        tenantId: alpha.id,
        responseId,
        now: new Date(),
      });
    });
    await expect(attempt).rejects.toBeInstanceOf(ClaimRefusedError);

    // The first file was updated before the second was refused — and the
    // rollback took that update with it. Without the throw it would have
    // committed: an answer carrying one of its two attachments.
    const first = await prisma.file.findUniqueOrThrow({
      where: { publicRef: good },
    });
    expect(first.responseId).toBeNull();
    // The answer row of this attempt was created by the helper *outside* the
    // transaction, so what is measured here is the claim's own rollback.
    expect(await prisma.response.count()).toBe(responsesBefore + 1);
  });

  /** No. 6, the count — enforced at claim time, because only here is there an answer. */
  it('refuses more files than one answer may carry', async () => {
    const refs = [];
    for (let i = 0; i <= MAX_FILES_PER_RESPONSE; i += 1) {
      refs.push(await file({ byteSize: 8 }));
    }
    expect(refs).toHaveLength(MAX_FILES_PER_RESPONSE + 1);

    expect(await refusalOf(claim(refs))).toBe(CLAIM_REFUSAL.tooMany);
    // Nothing was claimed: the count is judged on what the submission *names*,
    // before a single `UPDATE`.
    const claimed = await prisma.file.count({
      where: { publicRef: { in: refs }, responseId: { not: null } },
    });
    expect(claimed).toBe(0);
  });

  /** No. 6, the bytes. */
  it('refuses more bytes than one answer may carry', async () => {
    const half = Math.ceil(MAX_RESPONSE_BYTES / 2) + 1;
    const refs = [
      await file({ byteSize: half }),
      await file({ byteSize: half }),
    ];

    expect(await refusalOf(claim(refs))).toBe(CLAIM_REFUSAL.tooMany);
    const claimed = await prisma.file.count({
      where: { publicRef: { in: refs }, responseId: { not: null } },
    });
    expect(claimed).toBe(0);
  });

  /**
   * A row whose size is unknown is the crash window of no. 4 — the row exists,
   * `put()` never returned. It contributes nothing to the total and is refused,
   * because „wir wissen es nicht" must not be summed as „nichts".
   */
  it('refuses a file whose bytes were never confirmed', async () => {
    const ref = await file({ byteSize: null });
    expect(await refusalOf(claim([ref]))).toBe(CLAIM_REFUSAL.unavailable);
  });

  it('refuses a reference that is not one, without asking the database', async () => {
    expect(await refusalOf(claim(['nicht/erlaubt']))).toBe(
      CLAIM_REFUSAL.unavailable,
    );
    expect(await refusalOf(claim([randomUUID(), randomUUID()]))).toBe(
      CLAIM_REFUSAL.unavailable,
    );
  });

  it('refuses the same file named twice in one submission', async () => {
    const ref = await file();
    expect(await refusalOf(claim([ref, ref]))).toBe(CLAIM_REFUSAL.unavailable);
  });
});
