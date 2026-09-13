import { randomBytes } from 'node:crypto';

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { UNCLAIMED_FILE_LIFETIME_MS } from '@formsache/shared';

import { FilePurgeService } from '../../src/files/purge/file-purge.service';
import { resetAddressFormAllowances } from '../../src/public/address-form-tracker';
import { resetUploadQuota } from '../../src/public/upload-quota';
import { SettingsSecretsService } from '../../src/settings/settings-secrets.service';
import { RetentionPurgeService } from '../../src/trash/purge/retention-purge.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { MutableClock } from '../mail/mail-test-context';
import {
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import { createTenant, type TenantFixture } from '../support/fixtures';
import { InMemoryFileStorage } from '../support/in-memory-file-storage';
import { NO_SECTIONS } from '../support/settings-sections';

/**
 * **A draft owns its attachments** — the requirement,
 * the specification, ADR-0014 no. 13 and no. 15.
 *
 * Up to here an attachment in the draft lived 24 hours and the draft thirty
 * days; the shorter period won, and whoever came back on the second day was
 * asked to upload their proof once more. The specification has decided
 * this: **the attachment lives as long as its draft.** What this file
 * measures is the seam this one promise hangs on — the second
 * owner column, the transfer of the claim on submission, and the purge that
 * knows both arms.
 *
 * ## The clock is moved forward, never slept on
 *
 * Every period here is 24 hours or thirty days long. It is measured on the
 * **injected** clock (`MutableClock`), from which `FilePurgeService` and
 * `RetentionPurgeService` compute their cut-off; `file.created_at`, in
 * contrast, is written by the database clock, and that is exactly the reason
 * why a calendar moved forward lets the file age without anybody waiting.
 *
 * ## What is measured on the storage and what on the database
 *
 * "Physically gone" is the question put to the storage double
 * (`storage.read(id)`), not to a repository: a repository that filters would
 * look exactly like a deletion — and the bytes of a certificate that stay
 * lying on the tape are the case the whole deletion promise is written against.
 *
 * ## The pair of tests
 *
 * Two cases against two wrong designs — and what they achieve **measured**
 * stands here instead of an assertion (both reproductions run on
 * 2026-08-06):
 *
 * | design | "refused submission" | "fails at the COMMIT" |
 * |---|---|---|
 * | transfer **after** the transaction | **red** (a response is stored although 409) | green |
 * | transfer in a transaction of **its own** | red (the attachment belongs to nobody any more) | **red** |
 *
 * The first case therefore catches both, the second exactly one — and both
 * stand here nevertheless, because they measure different **points in time**:
 * the first a failure *before* the transfer (the refusal of the claim), the
 * second one **afterwards**, at the `COMMIT`, where the refusal path of the
 * first never arrives. Exactly this second place is the one where the queuing of the mail
 * was measured once before, and it needs an error that only a
 * `CONSTRAINT TRIGGER … DEFERRABLE` produces.
 */

const PAGE = '019ff700-0000-7000-8000-0000000000a0';
const NAME = '019ff700-0000-7000-8000-000000000001';
const NACHWEIS = '019ff700-0000-7000-8000-000000000002';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const definition = {
  pages: [
    {
      id: PAGE,
      title: 'Anmeldung',
      description: null,
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
          maxFiles: 3,
        },
      ],
    },
  ],
};

/** A real PDF header plus filler — the server checks the content, not the name. */
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

describe('ein Entwurf besitzt seine Anlagen', () => {
  let database: TestDatabase;
  let testApp: TestApp;
  let storage: InMemoryFileStorage;
  let clock: MutableClock;
  let tenant: TenantFixture;
  let slug: string;
  let formId: string;
  /** The instant every case starts from — restored after the ones that move it. */
  let epoch: Date;

  const app = (): TestApp => testApp;
  const filePurge = (): FilePurgeService => testApp.app.get(FilePurgeService);
  const draftPurge = (): RetentionPurgeService =>
    testApp.app.get(RetentionPurgeService);

  beforeAll(async () => {
    database = await acquireTestDatabase();
    storage = new InMemoryFileStorage();
    epoch = new Date();
    clock = new MutableClock(epoch);
    testApp = await createTestApp({
      databaseUrl: database.url,
      env: { TRUST_PROXY_HOPS: 1 },
      storage,
      clock,
    });

    tenant = await createTenant(testApp.prisma, 'DRAFTFILE');
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
    // *Zwischenspeichern* and *Bearbeiten nach Absenden* both on: the first is
    // what this file is about, the second is what the correction case of the specification
    // no. 84 needs. Sealed through the application's own service, the way an
    // editor's save writes it, so the document is one this server reads back.
    const secrets = testApp.app.get(SettingsSecretsService);
    await testApp.prisma.form.update({
      where: { id: form.id },
      data: {
        publishedVersionId: version.id,
        settingsOverride: secrets.sealFormOverride(
          {
            overridden: { ...NO_SECTIONS, access: true },
            values: { allowSaveDraft: true, allowEdit: true },
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
    clock.set(epoch);
    resetUploadQuota();
    resetAddressFormAllowances();
  });

  // ─── the routes, as a participant walks them ────────────────────────────

  async function upload(fileName: string): Promise<Uploaded> {
    const answered = await request(app().server)
      .post(apiPath(`/public/forms/${slug}/files`))
      .set('X-Forwarded-For', ownAddress())
      .set('Content-Type', 'application/octet-stream')
      .set('X-File-Name', encodeURIComponent(fileName))
      .send(pdf());
    expect(answered.status).toBe(201);
    return answered.body as Uploaded;
  }

  const answerWith = (files: readonly Uploaded[]): Record<string, unknown> => ({
    [NAME]: 'Anton',
    [NACHWEIS]: {
      files: files.map((file) => ({ ref: file.ref, name: file.fileName })),
    },
  });

  async function saveDraft(answers: Record<string, unknown>): Promise<string> {
    const saved = await request(app().server)
      .post(apiPath(`/public/forms/${slug}/drafts`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers });
    expect(saved.status).toBe(200);
    return (saved.body as { token: string }).token;
  }

  async function writeDraft(
    token: string,
    answers: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app().server)
      .put(apiPath(`/public/drafts/${token}`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers });
  }

  async function readDraft(token: string): Promise<request.Response> {
    return request(app().server)
      .get(apiPath(`/public/drafts/${token}`))
      .set('X-Forwarded-For', ownAddress());
  }

  async function submit(
    answers: Record<string, unknown>,
    draftToken?: string,
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers, ...(draftToken === undefined ? {} : { draftToken }) });
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

  /** The uploads a fixture promised, as values rather than `T | undefined`. */
  function only(files: readonly Uploaded[], index = 0): Uploaded {
    const file = files[index];
    if (file === undefined) {
      throw new Error(`fixture: no upload at index ${String(index)}`);
    }
    return file;
  }

  /** Upload, then hang it on a fresh draft — the ordinary way in. */
  async function draftWith(
    ...names: readonly string[]
  ): Promise<{ token: string; files: Uploaded[] }> {
    const files: Uploaded[] = [];
    for (const name of names) {
      files.push(await upload(name));
    }
    return { token: await saveDraft(answerWith(files)), files };
  }

  /** Both owner columns and the row's own key, read without any service. */
  async function rowOf(ref: string): Promise<{
    id: string;
    responseId: string | null;
    draftId: string | null;
  }> {
    return app().prisma.file.findUniqueOrThrow({
      where: { publicRef: ref },
      select: { id: true, responseId: true, draftId: true },
    });
  }

  /** Whether the row is still physically there — no `where` but the key. */
  async function rowExists(id: string): Promise<boolean> {
    const rows = await app().prisma.$queryRaw<
      { count: number }[]
    >`SELECT count(*)::int AS "count" FROM "file" WHERE "id" = ${id}::uuid`;
    return (rows[0]?.count ?? 0) > 0;
  }

  /** Installs a database-level fault, runs the case, and takes it out again. */
  async function guard(
    statements: readonly string[],
    run: () => Promise<void>,
    cleanup: readonly string[],
  ): Promise<void> {
    for (const statement of statements) {
      await app().prisma.$executeRawUnsafe(statement);
    }
    try {
      await run();
    } finally {
      for (const statement of cleanup) {
        await app().prisma.$executeRawUnsafe(statement);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // the proof — the two periods, measured on the same clock
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **the proof of the requirement: the draft-bound file survives the
   * 24 hours** — the test that was missing for a long time (ADR-0014
   * no. 15, „die Falle, die aufgeschrieben werden muss").
   *
   * The counter-case stands in the same line and is the half without which
   * nothing at all would be measured here: a file **nobody** has named goes
   * in the same run. A test that sees only the first would be green with a
   * switched-off purge as well.
   *
   * *Reproduction:* take `draft_id IS NULL` out of the purge's predicate → the
   * draft's attachment goes with it, `runOnce()` reports 2 instead of 1, and
   * the expectations that follow fall. **Out of *both* statements** — the
   * selection (`candidates`) and the check under the lock (`purgeOne`) pose
   * the same predicate, and as long as the second poses it, the file survives
   * the first.
   *
   * ⚠️ **The two statements are therefore not measurable *separately* through
   * the route** (a finding of the security review, kept honestly here
   * instead of as a promise): this case proves the **pair**. Whoever changes
   * only the unlocked selection sees it green — the duplication is deliberate,
   * but it is not black-box measurable. A proof for `purgeOne` alone would need
   * a direct call of the private method with a row bound to a draft by SQL and
   * back-dated; that is deliberately not built.
   */
  it('nimmt die Anlage eines lebenden Entwurfs nicht, auch nach 25 Stunden', async () => {
    const { files } = await draftWith('Nachweis.pdf');
    const owned = await rowOf(only(files).ref);
    // The draft is the owner — that is the precondition, not the assurance,
    // and it stands here so that a failure further down is not read as
    // "purge broken".
    expect(owned.draftId).not.toBeNull();
    expect(owned.responseId).toBeNull();

    const abandoned = await upload('Nie-gespeichert.pdf');
    const orphan = await rowOf(abandoned.ref);
    expect(orphan.draftId).toBeNull();

    // **Moved forward, not slept**: the purge's cut-off is computed from the
    // injected clock, `created_at` stands on the database clock of a moment ago.
    clock.advance(UNCLAIMED_FILE_LIFETIME_MS + MINUTE_MS);
    expect(await filePurge().runOnce()).toBe(1);

    // the proof: the draft's attachment stands, row **and** bytes.
    expect(await rowExists(owned.id)).toBe(true);
    expect(storage.read(owned.id)).toBeDefined();

    // the proof: the one without both owners is gone, bytes first.
    expect(await rowExists(orphan.id)).toBe(false);
    expect(storage.read(orphan.id)).toBeUndefined();
  });

  /**
   * **And the read payload says the same.** The point in time a resumed
   * draft names for its attachment has, since the specification, been the
   * period **of the draft** — the same one that stands one line further down
   * in the payload. Before that it was 24 hours from the upload, and exactly
   * that number was the imposition: the screen showed an expiry that was not
   * the draft's.
   *
   * *Reproduction:* delete the draft arm in `resolveDraftAttachments` →
   * `expiresAt` falls back to "uploaded + 24 h" and both lines below turn
   * red (the second one even if nobody moves the clock).
   */
  it('meldet der Ansicht die Frist des Entwurfs, nicht die des Uploads', async () => {
    const { token } = await draftWith('Nachweis.pdf');

    const resumed = await readDraft(token);
    expect(resumed.status).toBe(200);
    const body = resumed.body as {
      attachments: { ref: string; expiresAt: string | null }[];
      expiresAt: string;
    };
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]?.expiresAt).toBe(body.expiresAt);
    // Thirty days and not one day — without this line the equality above
    // would also be true if both numbers carried the short period.
    expect(
      new Date(body.expiresAt).getTime() - epoch.getTime(),
    ).toBeGreaterThan(UNCLAIMED_FILE_LIFETIME_MS * 2);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // the proof — the transfer of the claim
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **the proof: after the submission the same file hangs on the response and
   * no longer on the draft** — both columns read.
   *
   * The second half is the one that gets forgotten: a row that carried *both*
   * owners would look right seen from the response and would still hang
   * on a draft that no longer exists.
   *
   * And the file here is **older than the 24 hours** — that is the case the
   * specification makes possible in the first place: before, exactly this
   * submission answered `409 attachment_unavailable`.
   *
   * ⚠️ **The age stands in the column, not on the injected clock** (a finding
   * of the security review). `clock` replaces the `MailClock` alone;
   * `file.created_at` and `response.submitted_at` are written by the **database
   * clock**, and the claim compares the two with each other. Merely moving the
   * clock forward would leave the file **seconds** old at the claim, and the
   * case would assert something it does not measure — this is why `created_at`
   * is written back, the way `draft.spec.ts` does it. The clock moves in
   * addition, so that the draft period, too, has seen two days.
   *
   * *Reproduction:* take `"draft_id" = NULL` out of the `SET` of the claim →
   * the database refuses the `UPDATE` with `file_kind_shape`, the submission
   * fails, and this case turns red instead of silently wrong. And: take the
   * draft arm out of the `WHERE` → `409`, the old imposition.
   */
  it('übergibt die Anlage vom Entwurf an die Antwort — und räumt den Entwurfs-Arm ab', async () => {
    const { token, files } = await draftWith('Nachweis.pdf');
    const before = await rowOf(only(files).ref);
    expect(before.draftId).not.toBeNull();

    // Two days later — beyond any upload period, within the period of the
    // draft. Both clocks, because both periods are meant: the column for
    // the 24 hours of the claim, the injected one for the thirty days.
    await app().prisma.file.update({
      where: { publicRef: only(files).ref },
      data: { createdAt: new Date(Date.now() - 2 * DAY_MS) },
    });
    clock.advance(2 * DAY_MS);
    const sent = await submit(answerWith(files), token);
    expect(sent.status).toBe(200);

    const response = await app().prisma.response.findFirstOrThrow({
      where: { formId },
      orderBy: { submittedAt: 'desc' },
      select: { id: true },
    });
    const after = await rowOf(only(files).ref);
    expect(after.responseId).toBe(response.id);
    expect(after.draftId).toBeNull();
    // The draft has disappeared with the same transaction.
    expect(await app().prisma.responseDraft.count({ where: { token } })).toBe(
      0,
    );
  });

  /**
   * **A submission that does not name its draft does not get its
   * attachment** — and the draft stays standing (a finding of the security review).
   *
   * The case the 377 cases under `test/public` did **not** see up to here:
   * they all drive the resumption path, which sends the token along.
   * From the ordinary filling page the submission came without it — `draftId`
   * `undefined`, in the `WHERE` therefore `"draft_id" = NULL::uuid` (never
   * true) next to a second arm demanding `draft_id IS NULL`, which after the
   * saving is false. **No row matches.** Measured through the real routes:
   * upload `201` → save as draft `200` → submit **`409`**, for a
   * file that is two seconds old and is on the screen.
   *
   * ⚠️ **And this refusal is right as it is** — it is the promise the case
   * „lässt die Anlage eines anderen Entwurfs unangetastet" measures. What was
   * repaired was therefore the caller (`apps/web/src/views/PublicFormView.tsx`
   * passes the token on, `PublicFormView.test.tsx` proves it), **not** the
   * claim: were it to accept a draft-bound file without a token as well,
   * a reference in one's own submission would be the way to a stranger's attachment.
   *
   * The second half is the second damage of the same hole: without the token
   * the draft is **not consumed** — half-filled personal
   * data would stand in `response_draft` for up to thirty days afterwards. With
   * the token it is gone.
   */
  it('lehnt eine Absendung ohne Entwurfs-Token ab und verzehrt den Entwurf nicht', async () => {
    const { token, files } = await draftWith('Nachweis.pdf');
    const responsesBefore = await app().prisma.response.count({
      where: { formId },
    });

    const refused = await submit(answerWith(files));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ reason: 'attachment_unavailable' });

    expect(await app().prisma.response.count({ where: { formId } })).toBe(
      responsesBefore,
    );
    // The draft stands, together with its attachment — nothing has been left behind.
    expect((await readDraft(token)).status).toBe(200);
    const still = await rowOf(only(files).ref);
    expect(still.draftId).not.toBeNull();
    expect(still.responseId).toBeNull();
    // And the row with the half-filled answers is still lying there.
    expect(await app().prisma.responseDraft.count({ where: { token } })).toBe(
      1,
    );

    // The same submission **with** the token: it goes through, and the draft
    // is consumed. Without this half the 409 above would only prove that
    // something or other is refused.
    expect((await submit(answerWith(files), token)).status).toBe(200);
    expect(await app().prisma.responseDraft.count({ where: { token } })).toBe(
      0,
    );
  });

  /**
   * **A draft claims no attachment of a stranger.**
   *
   * The conditions of the draft claim are those of the submission claim, and
   * that holds from the forbidden side as well: a file that already belongs to
   * **another** draft stays there — otherwise the reference in one's own
   * draft would be a way to take over somebody else's attachment and
   * afterwards pull it into one's own response.
   *
   * *Reproduction:* delete `f."draft_id" IS NULL` in the `WHERE` of
   * `claimForDraft` → the second draft takes it and both expectations below
   * turn red.
   */
  it('lässt die Anlage eines anderen Entwurfs unangetastet', async () => {
    const { files } = await draftWith('Fremd.pdf');
    const mine = only(files);
    const owner = (await rowOf(mine.ref)).draftId;

    const secondToken = await saveDraft(answerWith([mine]));

    expect((await rowOf(mine.ref)).draftId).toBe(owner);
    // And the reading door of the second draft tells it so: dead, byte-equal
    // to a reference that never existed.
    const resumed = await readDraft(secondToken);
    expect(
      (resumed.body as { attachments: { expiresAt: string | null }[] })
        .attachments,
    ).toStrictEqual([{ ref: mine.ref, expiresAt: null }]);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // the proof — if the draft expires, its attachments expire
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **the proof: if the draft expires, its files disappear physically from
   * the storage** — measured on the storage double, not on the database row.
   *
   * The path is the one `file.draft_id` builds with `ON DELETE SET NULL`: the
   * draft purge takes the row, the file loses its owner, and the file purge
   * then takes **bytes first** and the row afterwards. The case runs both
   * runs, because those are the two events — "the draft is gone" and "its
   * attachment is gone" — and a test that drives only the first does not prove
   * the promise.
   *
   * *Reproduction:* set `draft` to `onDelete: Cascade` → the row disappears
   * with the draft, `storage.read` stays **defined**, and the last expectation
   * turns red. Exactly the state from ADR-0014 no. 16: bytes without an index,
   * untraceable, because the seam has no `list()`.
   */
  it('nimmt die Anlage eines verfallenen Entwurfs — Bytes und Zeile', async () => {
    const { files } = await draftWith('Verfaellt.pdf');
    const row = await rowOf(only(files).ref);

    // Day 29: nothing happens, on neither of the two runs.
    clock.advance(29 * DAY_MS);
    await draftPurge().runOnce();
    expect(await filePurge().runOnce()).toBe(0);
    expect(storage.read(row.id)).toBeDefined();

    // Day 31: the draft is due.
    clock.advance(2 * DAY_MS);
    expect((await draftPurge().runOnce()).drafts).toBeGreaterThanOrEqual(1);
    // The owner is gone, the bytes still there — that is the intermediate
    // state, and it belongs in the measurement: without it there would be no
    // saying which of the two runs took the bytes.
    expect((await rowOf(only(files).ref)).draftId).toBeNull();
    expect(storage.read(row.id)).toBeDefined();

    // Row-related instead of on the number of the run: the run goes over the
    // whole installation, and with the clock on day 31 the drafts of the
    // previous cases of this file have become due as well. What is promised is
    // a statement about **this** attachment.
    await filePurge().runOnce();
    expect(storage.read(row.id)).toBeUndefined();
    expect(await rowExists(row.id)).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // the specification — what a correction removes goes after 24 hours
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **The additional proof of the requirement.**
   *
   * An attachment that a **correction** removes from a submitted response
   * goes on expiring after 24 hours — measured from the *upload*,
   * not from the removal —, while the response and its remaining attachments
   * stay standing. The difference lies in the **intention**: what hangs on
   * the draft lives thirty days; what somebody takes out of their response
   * they do not want any more.
   *
   * **And the case deliberately goes through the draft**, otherwise it would be
   * a duplicate of the old proof: the file was the property of a draft, passed
   * to the response on submission and is now released. That
   * proves that `releaseAttachments` releases **both** arms — had the transfer
   * left `draft_id` standing, or were the release to leave it standing, the row
   * would be invisible to the new purge and would lie on the tape forever.
   *
   * *Reproduction:* take `"response_id" = NULL` out of `releaseAttachments` →
   * the row keeps its owner, `runOnce()` reports 0, and the two
   * expectations about the disappearance turn red.
   *
   * ⚠️ **What is *not* reproducible here, and the sentence once stood wrong in
   * this place** (a finding of the security review): "take `draft_id = NULL`
   * out of both statements" describes nothing these lines show.
   * Out of `releaseAttachments` alone the assignment is a **no-op** today — at
   * this point in time the row belongs to a response, and `file_kind_shape`
   * forbids a second owner next to it; out of the claim alone
   * the `UPDATE` already fails on that very `CHECK`, and so does the submission.
   * A state "stored response, row keeps its draft arm" cannot be produced
   * through the routes. That the release writes **both** arms is proven by the
   * fact that the row has taken this path (draft →
   * response → released) and the purge finds it.
   */
  it('entlässt die Anlage, die eine Korrektur entfernt — und die Purge nimmt sie', async () => {
    const { token, files } = await draftWith('Bleibt.pdf', 'Geht.pdf');
    const kept = only(files, 0);
    const dropped = only(files, 1);

    expect((await submit(answerWith(files), token)).status).toBe(200);
    const response = await app().prisma.response.findFirstOrThrow({
      where: { formId },
      orderBy: { submittedAt: 'desc' },
      select: { id: true, editToken: true },
    });
    const droppedRow = await rowOf(dropped.ref);
    const keptRow = await rowOf(kept.ref);
    expect(droppedRow.responseId).toBe(response.id);
    expect(droppedRow.draftId).toBeNull();

    /*
     * **The clock stands between upload and removal** (a finding of the
     * security review): 20 hours before the correction, 5 after it.
     * Without this cut "from the upload" and "from the removal" would deliver
     * the same result, and the sentence above would be an assertion. This way
     * it measures: 25 hours since the upload, but only 5 since the removal — a
     * period from the removal would **not** take the file.
     */
    clock.advance(20 * HOUR_MS);

    // The correction names only the one attachment any more.
    expect(
      (await writeEdit(response.editToken ?? '', answerWith([kept]))).status,
    ).toBe(200);

    const released = await rowOf(dropped.ref);
    expect(released.responseId).toBeNull();
    expect(released.draftId).toBeNull();

    // 24 hours **from the upload** : the release does not set a
    // new period, it resets the claim.
    clock.advance(5 * HOUR_MS + MINUTE_MS);
    expect(await filePurge().runOnce()).toBe(1);

    expect(storage.read(droppedRow.id)).toBeUndefined();
    expect(await rowExists(droppedRow.id)).toBe(false);

    // And the response together with its remaining attachment stands — the
    // half without which "is gone" would also come from a run that takes too much.
    expect(
      await app().prisma.response.count({ where: { id: response.id } }),
    ).toBe(1);
    expect(storage.read(keptRow.id)).toBeDefined();
    expect((await rowOf(kept.ref)).responseId).toBe(response.id);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The pair of tests — two wrong designs, two cases
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **Pair of tests, first half: the transfer belongs *inside* the transaction
   * — measured on a submission that is refused.**
   *
   * Next to its own attachment the submission names a reference that does not
   * exist; the claim refuses and takes the response with it. Afterwards
   * everything has to stand unchanged: no `response`, the draft still there,
   * the attachment still its own.
   *
   * *Reproduction:* put the transfer of the claim **after** the transaction
   * (the `DELETE` of the draft stays in, the claim runs after the `COMMIT`) →
   * the transaction commits, the draft is deleted, `SET NULL` takes the
   * file's owner away from it, and **three** expectations below turn red: the
   * response exists, the draft is gone, and the file belongs to nobody —
   * gone in 24 hours, then, although the participant sees it while editing.
   */
  it('lässt eine abgelehnte Absendung Entwurf und Anspruch, wie sie waren', async () => {
    const { token, files } = await draftWith('Nachweis.pdf');
    const mine = only(files);
    const responsesBefore = await app().prisma.response.count({
      where: { formId },
    });

    const refused = await submit(
      answerWith([
        mine,
        // Well-formed and names nothing — the one refusal for all the
        // conditions of the claim.
        { ref: randomBytes(16).toString('base64url'), fileName: 'Fremd.pdf' },
      ]),
      token,
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ reason: 'attachment_unavailable' });

    expect(await app().prisma.response.count({ where: { formId } })).toBe(
      responsesBefore,
    );
    expect((await readDraft(token)).status).toBe(200);
    const still = await rowOf(mine.ref);
    expect(still.draftId).not.toBeNull();
    expect(still.responseId).toBeNull();
  });

  /**
   * **Pair of tests, second half: the transfer belongs in the *same*
   * transaction — measured on a response that fails at the `COMMIT`.**
   *
   * The error is a `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on
   * `response`, that is, one that only strikes at the `COMMIT`: the response is
   * written, the claim has run, the draft is deleted — and
   * then everything falls back. Exactly this placement is the point; an error
   * *before* the `response.create` would stay green with a transaction of its
   * own for the transfer as well and would prove nothing about the shared
   * `BEGIN`. The same design measures the requirement for the queuing of the mail.
   *
   * *Reproduction:* put `claimAttachments` (or only the draft arm out of it)
   * into a `$transaction` of its own → the takeover commits, the response
   * rolls back, and the file afterwards hangs on a response that does not
   * exist, or on nothing at all: the last two expectations turn red,
   * while the participant goes on seeing their draft in front of them.
   */
  it('behält den Anspruch des Entwurfs, wenn das Speichern der Antwort beim COMMIT scheitert', async () => {
    const { token, files } = await draftWith('Nachweis.pdf');
    const mine = only(files);
    const owner = (await rowOf(mine.ref)).draftId;
    const responsesBefore = await app().prisma.response.count({
      where: { formId },
    });

    await guard(
      [
        'CREATE OR REPLACE FUNCTION test_fail_response() RETURNS trigger ' +
          "LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'response blocked by test'; END $$",
        'CREATE CONSTRAINT TRIGGER test_response_commit_guard AFTER INSERT ON "response" ' +
          'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_fail_response()',
      ],
      async () => {
        const answered = await submit(answerWith([mine]), token);
        expect(answered.status).toBe(500);
      },
      [
        'DROP TRIGGER test_response_commit_guard ON "response"',
        'DROP FUNCTION test_fail_response()',
      ],
    );

    expect(await app().prisma.response.count({ where: { formId } })).toBe(
      responsesBefore,
    );
    // The draft stands — and its attachment belongs to it unchanged.
    expect((await readDraft(token)).status).toBe(200);
    const after = await rowOf(mine.ref);
    expect(after.draftId).toBe(owner);
    expect(after.responseId).toBeNull();
  });

  /**
   * **The draft owns at most what it names** — the third case the specification
   * left open, decided in the security review (a review finding) and
   * recorded with the requirement.
   *
   * Until then this case stood here **the other way round**: it proved that
   * the draft path releases nothing, and called that a named gap. The
   * arithmetic behind it was the argument for closing it: the waiting room from
   * ADR-0014 no. 7 refills every 48 hours (25 MiB and 20 files per
   * address ⊕ form), a draft lives thirty days — **fifteen** fillings
   * could be put into *one* draft by repeated `PUT`: 375 MiB and
   * 300 files per address and form, over a route without a session.
   * `MAX_DRAFTS_PER_FORM` does not bind that, it counts drafts, not attachments.
   *
   * The released attachment thereby falls under the same 24-hour purge as the
   * one a correction takes out of a response — measured from the
   * upload.
   *
   * **The second half is the one without which "releases" would also come from
   * an `UPDATE` that takes too much:** the attachment that the same version
   * **still** names keeps its claim and survives the same run.
   *
   * *Reproduction:* take `releaseDraftAttachments` out of {@link updateDraft} →
   * `runOnce()` reports 0 and the second-to-last expectation turns red. Invert
   * the `NOT (…= ANY …)` → the remaining attachment goes with it and the last
   * two turn red.
   */
  it('entlässt die Anlage, die der Entwurf nicht mehr nennt — und behält die, die er nennt', async () => {
    const { token, files } = await draftWith('Bleibt.pdf', 'Geht.pdf');
    const kept = only(files, 0);
    const dropped = only(files, 1);
    const owner = (await rowOf(kept.ref)).draftId;
    const droppedRow = await rowOf(dropped.ref);
    expect(droppedRow.draftId).toBe(owner);

    // The same version, one attachment fewer.
    expect((await writeDraft(token, answerWith([kept]))).status).toBe(200);

    expect((await rowOf(dropped.ref)).draftId).toBeNull();
    expect((await rowOf(kept.ref)).draftId).toBe(owner);

    clock.advance(UNCLAIMED_FILE_LIFETIME_MS + MINUTE_MS);
    expect(await filePurge().runOnce()).toBe(1);

    // Physically, on the storage double — and the draft together with its
    // remaining attachment stands.
    expect(storage.read(droppedRow.id)).toBeUndefined();
    expect(await rowExists(droppedRow.id)).toBe(false);
    expect((await readDraft(token)).status).toBe(200);
    expect(storage.read((await rowOf(kept.ref)).id)).toBeDefined();
  });

  /**
   * **A row without bytes does not get a draft owner** (a finding of the
   * security review).
   *
   * A `pending` row that got stuck is the crash window from ADR-0014
   * no. 4: the row stands, `put()` never finished, `byte_size` is
   * `NULL`. Were the draft claim to take it, it would live thirty *days*
   * instead of 24 hours — and in the end the submission would refuse it all
   * the same, because
   * `claimAttachments` counts an unknown size as a refusal and not as zero.
   * Property that no submission can use is mere keeping.
   *
   * *Reproduction:* delete `f."byte_size" IS NOT NULL` from `claimForDraft` →
   * the row gets an owner, both expectations below turn red.
   */
  it('beansprucht keine Zeile ohne Bytes für den Entwurf', async () => {
    const ref = randomBytes(16).toString('base64url');
    // Raw, because through the routes there is no way to a `pending` row:
    // the upload writes row and bytes in one call. `gen_random_uuid()`
    // writes a v4 where Prisma would write a v7 — nothing here reads an
    // ordering off it, and the row carries no bytes anyway.
    await app().prisma.$executeRaw`
      INSERT INTO "file" ("id", "tenant_id", "form_id", "kind", "public_ref",
                          "file_name", "content_type", "status", "created_at")
      VALUES (gen_random_uuid(), ${tenant.id}::uuid, ${formId}::uuid,
              'response_attachment'::"file_kind", ${ref}, 'Steckengeblieben.pdf',
              'application/pdf', 'pending'::"file_status", now())`;

    const token = await saveDraft(
      answerWith([{ ref, fileName: 'Steckengeblieben.pdf' }]),
    );
    const stuck = await rowOf(ref);
    expect(stuck.draftId).toBeNull();

    // And it therefore goes after 24 hours, like every file without both owners
    // — measured row-related, because the run goes over the whole installation.
    clock.advance(UNCLAIMED_FILE_LIFETIME_MS + MINUTE_MS);
    await filePurge().runOnce();
    expect(await rowExists(stuck.id)).toBe(false);
    // The draft itself has been saved — an attachment that cannot be claimed
    // is no reason to refuse somebody the saving of a draft.
    expect((await readDraft(token)).status).toBe(200);
  });
});
