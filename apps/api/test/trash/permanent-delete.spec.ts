import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PURGE_STORAGE_UNAVAILABLE_MESSAGE,
  TRASH_PURGE_BATCH_SIZE,
  parseMailLogDetail,
  parseMailLogList,
} from '@formsache/shared';

import { MailWorkerService } from '../../src/mail/mail-worker.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { MutableClock } from '../mail/mail-test-context';
import {
  TEST_PUBLIC_BASE_URL,
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
import { SmtpDouble } from '../support/smtp-double';

/**
 * **Permanent deletion is physical deletion** .
 *
 * Four promises, and every one of them is measured where it is *made* rather
 * than where it is displayed:
 *
 * 1. the personal columns of `mail_log` are empty and the row is still there —
 *    asserted column by column, **by name**, so a further such column added
 *    later stands out instead of being inherited. Naming them is necessary and
 *    was not sufficient: `last_error` was the fifth and went unnamed for a
 *    release (a review finding), which is why „empties last_error too" below
 *    searches the **whole** row instead;
 * 2. the answer is **out of the database**, counted with `count(*)`, not asked
 *    of a route: a route that filters `deleted_at` answers the same for a soft
 *    delete, which is precisely the implementation this requirement rules out;
 * 3. its attachments are gone from the **storage**, bytes and row (the proof,
 *    ADR-0014 no. 16) — asked of the storage double, because a deleted row
 *    with live bytes is the failure mode the whole ordering exists to prevent;
 * 4. the mail log parses the blanked row through the wire contract the
 *    view uses (`parseMailLogList`), which is what „rendert, ohne zu brechen"
 *    means on this side of the seam.
 *
 * ## The rights are asserted through the refusal, in both directions
 *
 * Permanent deletion and „Papierkorb leeren" need `can_view_responses` **and**
 * `can_build` (decision of 2026-08-03). Two members carry
 * **four of the five** permissions each and differ in exactly the one under
 * test, so a 403 cannot be „this person happens to hold nothing":
 *
 * - `builder` — everything except `can_view_responses`;
 * - `viewer` — everything except `can_build`.
 *
 * And every refusal is followed by a count: „403" alone would be satisfied by a
 * route that answers 403 *after* deleting.
 */

const PASSWORD = 'test-password';

const PAGE = '019ffe00-0000-7000-8000-0000000000a0';
const NAME_QUESTION = '019ffe00-0000-7000-8000-000000000001';
const MAIL_QUESTION = '019ffe00-0000-7000-8000-000000000002';
const FILE_QUESTION = '019ffe00-0000-7000-8000-000000000003';

/** The address the participant types in — the personal datum under test. */
const PARTICIPANT = 'anton@example.invalid';
const SUBJECT = 'Anmeldung eingegangen';
/**
 * The reply address of the organisation — it lands in `mail_log.reply_to` when
 * the line is queued and is the **counter-check** to the columns
 * that the permanent deletion empties.
 *
 * Without a value here, the promise from `mail-log-erasure.ts` — „`reply_to`
 * gehört **nicht** zu den personenbezogenen Spalten" — was unproven: the
 * fixture left the column `NULL`, and `NULL` stays `NULL`, emptied or not.
 */
const TENANT_REPLY_TO = 'geschaeftsstelle@example.invalid';

const questionBase = { hint: null, required: false, width: 'full' as const };

const definition = {
  pages: [
    {
      id: PAGE,
      title: 'Anmeldung',
      description: null,
      questions: [
        {
          ...questionBase,
          id: NAME_QUESTION,
          type: 'text',
          label: 'Name',
          minLength: null,
          maxLength: null,
          pattern: null,
        },
        {
          ...questionBase,
          id: MAIL_QUESTION,
          type: 'email',
          label: 'E-Mail',
        },
        {
          ...questionBase,
          id: FILE_QUESTION,
          type: 'file',
          label: 'Nachweis',
          maxFiles: 2,
        },
      ],
    },
  ],
};

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

/** A minimal PNG — the upload derives the type from the signature, not the name. */
function png(bytes: number): Buffer {
  const header = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
  ]);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, bytes - 16), 7)]);
}

interface Submission {
  readonly formId: string;
  readonly slug: string;
  readonly responseId: string;
  /** The first attachment — what every single-file case names. */
  readonly fileId: string;
  /** All of them, in upload order — what the multi-file case needs. */
  readonly fileIds: readonly string[];
}

describe('endgültiges Löschen', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let admin: string;
  let betaAdmin: string;
  let builder: string;
  let viewer: string;
  /**
   * Somebody who holds **everything** in the organisation and is capped or revoked on a
   * single form — the shape a review finding is about. A member who lacked a
   * permission tenant-wide would be refused by the guard chain before the
   * listing is even reached, and would prove nothing about the listing.
   */
  let capped: string;
  let cappedUserId: string;
  /** A cap to a role **without** `can_build` — „Nur lesen" on one form. */
  let readOnlyGroupId: string;
  /** A cap to a role **without** `can_view_responses` — builds, sees no answers. */
  let buildOnlyGroupId: string;
  let storage: InMemoryFileStorage;
  let transport: SmtpDouble;
  let worker: MailWorkerService;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    storage = new InMemoryFileStorage();
    transport = new SmtpDouble();
    testApp = await createTestApp({
      databaseUrl: database.url,
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
      env: { TRUST_PROXY_HOPS: 1 },
      storage,
      transport,
      clock: new MutableClock(new Date()),
    });
    worker = testApp.app.get(MailWorkerService);

    alpha = await createTenant(testApp.prisma, 'PURGE');
    beta = await createTenant(testApp.prisma, 'FREMD');

    // So that every queued line carries a reply address — see
    // {@link TENANT_REPLY_TO}.
    await testApp.prisma.tenant.update({
      where: { id: alpha.id },
      data: { replyTo: TENANT_REPLY_TO },
    });

    const adminUser = await createUser(testApp.prisma, {
      email: 'admin@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    admin = await openSession(testApp, adminUser.id, alpha.id);

    const betaUser = await createUser(testApp.prisma, {
      email: 'beta@example.org',
      password: PASSWORD,
      tenants: [beta],
    });
    betaAdmin = await openSession(testApp, betaUser.id, beta.id);

    const builderUser = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'builder@example.org',
      groupName: 'bearbeiter',
      permissions: {
        canBuild: true,
        canViewResponses: false,
        canExport: true,
        canManageSettings: true,
        canManageFormSettings: true,
        canManageUsers: true,
      },
    });
    builder = await openSession(testApp, builderUser.id, alpha.id);

    const viewerUser = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'viewer@example.org',
      groupName: 'leser',
      permissions: {
        canBuild: false,
        canViewResponses: true,
        canExport: true,
        canManageSettings: true,
        canManageFormSettings: true,
        canManageUsers: true,
      },
    });
    viewer = await openSession(testApp, viewerUser.id, alpha.id);

    // Holds all five in the organisation — every refusal below is therefore the *cap*
    // or the *revocation* on one form, never „this person happens to hold
    // nothing" (the trap the requirements name outright).
    const cappedUser = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'gedeckelt@example.org',
      groupName: 'bearbeiter-voll',
      permissions: {
        canBuild: true,
        canViewResponses: true,
        canExport: true,
        canManageSettings: true,
        canManageFormSettings: true,
        canManageUsers: true,
      },
    });
    cappedUserId = cappedUser.id;
    capped = await openSession(testApp, cappedUser.id, alpha.id);

    readOnlyGroupId = (
      await createRestrictedMember(testApp.prisma, alpha, {
        email: 'nur-lesen@example.org',
        groupName: 'nur-lesen',
        permissions: { canBuild: false, canViewResponses: true },
      })
    ).groupId;
    buildOnlyGroupId = (
      await createRestrictedMember(testApp.prisma, alpha, {
        email: 'nur-bauen@example.org',
        groupName: 'nur-bauen',
        permissions: { canBuild: true, canViewResponses: false },
      })
    ).groupId;
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  // ─── fixtures, through the real routes ──────────────────────────────────

  async function publishedForm(
    title: string,
  ): Promise<{ id: string; slug: string }> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(admin))
      .send({ title });
    expect(created.status).toBe(201);
    const form = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };

    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(admin))
      .send({ title, definition, revision: form.revision });
    expect(saved.status).toBe(200);

    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(admin))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    return { id: form.id, slug: form.publicSlug };
  }

  async function configureConfirmation(formId: string): Promise<void> {
    const form = await app().prisma.form.findUniqueOrThrow({
      where: { id: formId },
      select: { settingsRevision: true, tenantId: true },
    });
    const tenant = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: form.tenantId },
      select: { formDefaultsRevision: true },
    });
    const settings = await request(app().server)
      .put(apiPath(`/forms/${formId}/settings`))
      .set(authedMutation(admin))
      .send({
        overridden: {
          access: true,
          confirm: true,
          display: false,
          budget: false,
        },
        values: { allowEdit: true },
        revision: form.settingsRevision,
        tenantRevision: tenant.formDefaultsRevision,
      });
    expect(settings.status).toBe(200);

    const notification = await request(app().server)
      .post(apiPath(`/forms/${formId}/notifications`))
      .set(authedMutation(admin))
      .send({
        name: 'Bestätigung',
        subject: SUBJECT,
        body: 'Wir haben deine Anmeldung erhalten.',
        recipients: [{ kind: 'question', questionId: MAIL_QUESTION }],
        replyTo: null,
      });
    expect(notification.status).toBe(201);
  }

  /**
   * One form, one notification, one submission **with an attachment** — the
   * complete fixture every case below deletes.
   *
   * Built through the shipped routes rather than written into the tables: an
   * upload that never went through `POST /public/forms/:slug/files` would have
   * no bytes in the storage, and „die Bytes sind weg" would be vacuously true.
   */
  async function submission(
    title: string,
    attachments = 1,
  ): Promise<Submission> {
    const form = await publishedForm(title);
    await configureConfirmation(form.id);

    const refs: string[] = [];
    for (let index = 0; index < attachments; index += 1) {
      const uploaded = await request(app().server)
        .post(apiPath(`/public/forms/${form.slug}/files`))
        .set('X-Forwarded-For', ownAddress())
        .set('Content-Type', 'application/octet-stream')
        .set('X-File-Name', encodeURIComponent(`nachweis-${String(index)}.png`))
        .send(png(64 + index));
      expect(uploaded.status).toBe(201);
      refs.push((uploaded.body as { ref: string }).ref);
    }

    const sent = await request(app().server)
      .post(apiPath(`/public/forms/${form.slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({
        answers: {
          [NAME_QUESTION]: 'Anton Aktiv',
          [MAIL_QUESTION]: PARTICIPANT,
          [FILE_QUESTION]: {
            files: refs.map((ref, index) => ({
              ref,
              name: `nachweis-${String(index)}.png`,
            })),
          },
        },
      });
    expect(sent.status).toBe(200);

    const response = await app().prisma.response.findFirstOrThrow({
      where: { formId: form.id },
      orderBy: { submittedAt: 'desc' },
      select: { id: true },
    });
    const fileIds: string[] = [];
    for (const ref of refs) {
      const file = await app().prisma.file.findFirstOrThrow({
        where: { publicRef: ref },
        select: { id: true, responseId: true },
      });
      // The claim actually happened — otherwise the file is an orphan and the
      // purge would be what deletes it, not this requirement.
      expect(file.responseId).toBe(response.id);
      expect(storage.read(file.id)).toBeDefined();
      fileIds.push(file.id);
    }

    return {
      formId: form.id,
      slug: form.slug,
      responseId: response.id,
      // The first one — every case that names a single attachment means this.
      fileId: fileIds[0] ?? '',
      fileIds,
    };
  }

  async function trashResponse(item: Submission): Promise<void> {
    const deleted = await request(app().server)
      .delete(apiPath(`/forms/${item.formId}/responses/${item.responseId}`))
      .set(authedMutation(admin));
    expect(deleted.status).toBe(204);
  }

  async function trashForm(formId: string): Promise<void> {
    const deleted = await request(app().server)
      .delete(apiPath(`/forms/${formId}`))
      .set(authedMutation(admin));
    expect(deleted.status).toBe(204);
  }

  function purgeResponse(item: Submission, token: string) {
    return request(app().server)
      .delete(
        apiPath(`/forms/${item.formId}/responses/${item.responseId}/permanent`),
      )
      .set(authedMutation(token));
  }

  function purgeForm(formId: string, token: string) {
    return request(app().server)
      .delete(apiPath(`/forms/${formId}/permanent`))
      .set(authedMutation(token));
  }

  function emptyTrash(token: string) {
    return request(app().server)
      .delete(apiPath('/trash'))
      .set(authedMutation(token));
  }

  /** What `DELETE /trash` answers, through the wire contract the view parses. */
  interface PurgeReport {
    forms: number;
    responses: number;
    failed: number;
    remaining: number;
  }

  /**
   * A `form_permission` row for {@link capped}, written straight into the table.
   *
   * Deliberately not through `PUT /forms/:id/permissions/:userId`: that route
   * refuses a cap that is not *ranked* below the person's own role, and the
   * guarantee under test is the one that trusts no ranking — a row can reach
   * this table past every route (a migration, a hand-edited database) and the
   * boundary has to hold anyway. It is the same reasoning `form-permission.spec.ts`
   * writes its rows by hand for.
   */
  async function restrict(
    formId: string,
    row: { accessRevoked: boolean; cappedGroupId: string | null },
  ): Promise<void> {
    await app().prisma.formPermission.create({
      data: { tenantId: alpha.id, formId, userId: cappedUserId, ...row },
    });
  }

  /** `DELETE /forms/:formId/responses/:responseId/permanent`, ids given freely. */
  function purgeResponseOf(formId: string, responseId: string, token: string) {
    return request(app().server)
      .delete(apiPath(`/forms/${formId}/responses/${responseId}/permanent`))
      .set(authedMutation(token));
  }

  /**
   * The trash of ALPHA, emptied until it stays empty — a starting state
   * for the cases that count what is left.
   */
  async function drainTrash(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const emptied = await emptyTrash(admin);
      expect(emptied.status).toBe(200);
      if ((emptied.body as PurgeReport).remaining === 0) {
        return;
      }
    }
    throw new Error('the Papierkorb would not empty');
  }

  /** The mail line of one submission, straight out of the table. */
  async function mailRow(formId: string) {
    return app().prisma.mailLog.findFirstOrThrow({
      where: { formId },
      select: {
        id: true,
        recipient: true,
        subject: true,
        bodyText: true,
        bodyHtml: true,
        status: true,
        attempts: true,
        createdAt: true,
        sentAt: true,
        senderIdentity: true,
        senderAddress: true,
        responseId: true,
        formId: true,
        lastError: true,
        replyTo: true,
      },
    });
  }

  const responseCount = (id: string): Promise<number> =>
    app().prisma.response.count({ where: { id } });

  // ═════════════════════════════════════════════════════════════════════════
  // the fourth proof, on one answer
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **the proof — the four columns, each by name.**
   *
   * *Reproduction, measured:* blanking only `recipient` and `subject` (dropping
   * `bodyText`/`bodyHtml` from `ERASED_MAIL_LOG_COLUMNS`) turns this case red on
   * the two body assertions — which is the shape the requirement asks for: „der
   * Test benennt **alle vier** namentlich, damit eine fünfte Spalte auffällt".
   *
   * The row itself has to survive with its operational half intact, so the
   * assertions on `status`, `attempts`, `createdAt`, `sentAt` and the two
   * identity columns of 0.2 are not decoration — they are the other half of the
   * promise („die Zeile steht noch").
   */
  it('empties recipient, subject, body_text and body_html and keeps the line', async () => {
    const item = await submission('Vier Spalten');

    // Sent, so the line carries an outcome and an identity — the columns the
    // requirement explicitly keeps.
    const before = await runWorker();
    expect(before.sends).toBeGreaterThan(0);

    const sentRow = await mailRow(item.formId);
    expect(sentRow.recipient).toBe(PARTICIPANT);
    expect(sentRow.subject).toBe(SUBJECT);
    expect(sentRow.bodyText).not.toBeNull();
    expect(sentRow.status).toBe('sent');
    expect(sentRow.senderIdentity).not.toBeNull();
    // The control for the counter-check below: the column is filled at all.
    expect(sentRow.replyTo).toBe(TENANT_REPLY_TO);

    await trashResponse(item);
    expect((await purgeResponse(item, admin)).status).toBe(204);

    const after = await mailRow(item.formId);
    expect(after.id).toBe(sentRow.id);
    // All four, by name.
    expect(after.recipient).toBeNull();
    expect(after.subject).toBeNull();
    expect(after.bodyText).toBeNull();
    expect(after.bodyHtml).toBeNull();
    // And what stays: the delivery record.
    expect(after.status).toBe('sent');
    expect(after.attempts).toBe(sentRow.attempts);
    expect(after.createdAt).toStrictEqual(sentRow.createdAt);
    expect(after.sentAt).toStrictEqual(sentRow.sentAt);
    expect(after.senderIdentity).toBe(sentRow.senderIdentity);
    expect(after.senderAddress).toBe(sentRow.senderAddress);
    /*
     * **The counter-check: `reply_to` stays standing** (review of
     * package 0-A).
     *
     * `mail-log-erasure.ts` expressly promises that this column does **not**
     * belong to the personal ones: it carries typed configuration, never
     * a value out of an answer, and thus stands in the same category as
     * `sender_address`. Up to here the promise was not measured — the
     * fixture left the column `NULL`, and an empty column proves nothing in
     * either direction.
     *
     * *Reproduction:* take `replyTo: null` into `ERASED_MAIL_LOG_COLUMNS` —
     * this line goes red.
     */
    expect(after.replyTo).toBe(TENANT_REPLY_TO);
    // `ON DELETE SET NULL` did its half; the form is still named.
    expect(after.responseId).toBeNull();
    expect(after.formId).toBe(item.formId);
  }, 60_000);

  /**
   * **the proof — the answer is gone from the database.**
   *
   * `count(*)` on the row, and on `event_registration`, not a route: a route
   * that filters `deleted_at` answers exactly the same for the soft delete this
   * requirement rules out. „Nicht mehr angezeigt" is not the claim.
   */
  it('removes the answer row itself, not only its deleted_at', async () => {
    const item = await submission('Physisch weg');
    await trashResponse(item);

    // Still there while it is in the trash — the control that makes the
    // assertion below about *this* route.
    expect(await responseCount(item.responseId)).toBe(1);

    expect((await purgeResponse(item, admin)).status).toBe(204);

    expect(await responseCount(item.responseId)).toBe(0);
    expect(
      await app().prisma.eventRegistration.count({
        where: { responseId: item.responseId },
      }),
    ).toBe(0);
  }, 60_000);

  /**
   * **the proof — the attachments are gone from the storage** (ADR-0014 no. 16).
   *
   * Both halves: the row **and** the bytes. Asking only the table would be
   * green for exactly the implementation the ADR forbids — row gone, bytes on
   * the volume, unfindable because the seam has no `list()`.
   */
  it('removes the answer’s attachments — bytes and row', async () => {
    const item = await submission('Anlagen weg');
    await trashResponse(item);

    expect(storage.read(item.fileId)).toBeDefined();

    expect((await purgeResponse(item, admin)).status).toBe(204);

    expect(storage.read(item.fileId)).toBeUndefined();
    expect(await app().prisma.file.count({ where: { id: item.fileId } })).toBe(
      0,
    );
  }, 60_000);

  /**
   * **the proof — the mail log does not break.**
   *
   * Through `parseMailLogList`, i.e. the **wire contract the view parses with**,
   * not through a hand-written expectation about the JSON: `mailLogEntrySchema`
   * is a `strictObject` and its `recipient` was `min(1)` until this requirement,
   * so a server writing an empty string would take the whole page down with a
   * parse error rather than showing one odd row (the open point named/0.2).
   *
   * *Reproduction:* set `recipient` back to `z.string().min(1)` in
   * `packages/shared/src/mail.ts` and this case is red — `parseMailLogList`
   * throws on the blanked line.
   */
  it('lets the Versandprotokoll parse the blanked line', async () => {
    const item = await submission('Protokoll');
    await trashResponse(item);
    expect((await purgeResponse(item, admin)).status).toBe(204);

    const log = await request(app().server)
      .get(apiPath(`/mail-log?formId=${item.formId}`))
      .set('Cookie', cookieHeader(admin));
    expect(log.status).toBe(200);

    const parsed = parseMailLogList(log.body);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.recipient).toBeNull();
    expect(parsed.entries[0]?.subject).toBeNull();
    // The operational half is what the page still has to show.
    expect(parsed.entries[0]?.status).toBeDefined();

    // **And the detail dialog of the same row**, which is the half that would
    // fail differently: it *renders* the frozen body, and `QueuedBodyRenderer`
    // refuses a row with no `body_text`. Answering 500 to „warum ging das raus"
    // would take the diagnosis away exactly where an operator goes looking.
    const detail = await request(app().server)
      .get(apiPath(`/mail-log/${parsed.entries[0]?.id ?? ''}`))
      .set('Cookie', cookieHeader(admin));
    expect(detail.status).toBe(200);
    const body = parseMailLogDetail(detail.body);
    expect(body.recipient).toBeNull();
    expect(body.bodyText).toBeNull();
    expect(body.bodyHtml).toBeNull();
  }, 60_000);

  /**
   * **A mail that is still waiting no longer goes out.**
   *
   * The hole this closes is specific: `mail_log.response_id` is
   * `ON DELETE SET NULL`, so the `NOT_IN_TRASH` condition that withheld the
   * line while the answer sat in the trash stops matching the moment the
   * answer is destroyed — the row would become claimable *because* of the
   * deletion, and a confirmation carrying the erased submission's frozen
   * answers would leave minutes later.
   *
   * Measured at the **transport**, like `withheld-mail.spec.ts`: a run that
   * claimed, rendered and then thought better of it would leave the row looking
   * the same and the mail would be out.
   */
  it('ends a still-queued line instead of letting it go out afterwards', async () => {
    const item = await submission('Wartende Post');
    const queued = await mailRow(item.formId);
    expect(queued.status).toBe('queued');

    await trashResponse(item);
    expect((await purgeResponse(item, admin)).status).toBe(204);

    const run = await runWorker();
    expect(run.sends).toBe(0);

    const after = await mailRow(item.formId);
    expect(after.status).toBe('failed');
    expect(after.lastError).toContain('endgültig gelöscht');
    expect(after.recipient).toBeNull();
  }, 60_000);

  // ═════════════════════════════════════════════════════════════════════════
  // A form has children
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **What hangs on the form goes with it** — and the one child that does not is
   * the log line, on purpose.
   *
   * `file` is the child with `ON DELETE NO ACTION` (ADR-0014 no. 16): if this
   * route did not enumerate and remove the attachments first, the `DELETE`
   * would fail with a foreign-key error rather than leaving bytes behind. That
   * is the database floor, and this case walks over it.
   */
  it('takes versions, answers, registrations, notifications and permissions with the form', async () => {
    const item = await submission('Mit Kindern');
    await runWorker();

    await app().prisma.formPermission.create({
      data: {
        tenantId: alpha.id,
        formId: item.formId,
        userId: (
          await app().prisma.user.findFirstOrThrow({
            where: { email: 'viewer@example.org' },
            select: { id: true },
          })
        ).id,
        accessRevoked: false,
        cappedGroupId: null,
      },
    });

    await trashForm(item.formId);
    expect((await purgeForm(item.formId, admin)).status).toBe(204);

    const prisma = app().prisma;
    expect(await prisma.form.count({ where: { id: item.formId } })).toBe(0);
    expect(
      await prisma.formVersion.count({ where: { formId: item.formId } }),
    ).toBe(0);
    expect(await responseCount(item.responseId)).toBe(0);
    expect(
      await prisma.eventRegistration.count({ where: { formId: item.formId } }),
    ).toBe(0);
    expect(
      await prisma.notification.count({ where: { formId: item.formId } }),
    ).toBe(0);
    expect(
      await prisma.formPermission.count({ where: { formId: item.formId } }),
    ).toBe(0);
    expect(await prisma.file.count({ where: { id: item.fileId } })).toBe(0);
    expect(storage.read(item.fileId)).toBeUndefined();

    // The one child that stays — blanked, and detached from **all three** of
    // its gone parents.
    //
    // The three are named one by one because `purgeForm` empties them itself
    // rather than leaving them to `ON DELETE SET NULL`: `mail_log` is the only
    // table whose `form` **and** whose `notification` die in the same
    // transaction, and PostgreSQL fires the referential actions of one
    // `DELETE` in the order the constraints were created — which no schema
    // states and no migration promises. In the order this installation's
    // `20260813000000_init` happens to build, leaving it to the cascade
    // answers 500 with
    // `insert or update on table "mail_log" violates … mail_log_notification_id_fkey`,
    // because the `UPDATE` that nulls `form_id` re-checks every key of a row
    // its own transaction has already written. The comment on `purgeForm`
    // carries the long version.
    const line = await prisma.mailLog.findFirstOrThrow({
      where: { id: (await lastLineOfTenant()).id },
      select: {
        recipient: true,
        subject: true,
        bodyText: true,
        bodyHtml: true,
        formId: true,
        notificationId: true,
        responseId: true,
        status: true,
      },
    });
    expect(line.recipient).toBeNull();
    expect(line.subject).toBeNull();
    expect(line.bodyText).toBeNull();
    expect(line.bodyHtml).toBeNull();
    expect(line.formId).toBeNull();
    expect(line.notificationId).toBeNull();
    expect(line.responseId).toBeNull();
    expect(line.status).toBe('sent');
  }, 60_000);

  /** The most recent line of ALPHA — used where the form id is already gone. */
  async function lastLineOfTenant() {
    return app().prisma.mailLog.findFirstOrThrow({
      where: { tenantId: alpha.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Only out of the trash, and only one's own organisation
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **A live answer is unreachable** — and nothing is blanked on the
   * way to finding that out.
   *
   * The second assertion is the load-bearing one. The erasure and the `DELETE`
   * are two statements, so an implementation that blanked first and checked
   * `deleted_at` in the `DELETE` alone would answer 404 here **and** have
   * destroyed a live submission's mail log.
   */
  it('refuses an answer that is not in the Papierkorb, and blanks nothing', async () => {
    const item = await submission('Lebendig');

    const refused = await purgeResponse(item, admin);
    expect(refused.status).toBe(404);

    expect(await responseCount(item.responseId)).toBe(1);
    const line = await mailRow(item.formId);
    expect(line.recipient).toBe(PARTICIPANT);
    expect(line.subject).toBe(SUBJECT);
    expect(line.bodyText).not.toBeNull();
    expect(storage.read(item.fileId)).toBeDefined();
  }, 60_000);

  /**
   * **An answer of a *different* form does not lose its attachments**
   * (a review finding).
   *
   * The route names both ids, and `purgeResponse` checks both — the enumeration
   * of the attachments checked only the answer. So naming form **A** with an
   * answer of form **B**, both in the same organisation, destroyed B's attachment bytes
   * *and* rows before the 404 arrived: unrecoverable, unreported, and reachable
   * with nothing more exotic than a stale form id in an open tab.
   *
   * The assertion that matters is the pair after the 404 — a case that only
   * asserted the status code would have been green throughout.
   *
   * *Reproduction, measured:* drop `formId` from
   * `ScopedFileDelegate.attachmentIdsOfResponse`'s `where` and this case is red
   * on `storage.read` and `file.count`, with the 404 unchanged.
   */
  it('does not touch the attachments of an answer that belongs to another form', async () => {
    const victim = await submission('Anlagen der Fremden');
    const decoy = await publishedForm('Falsch geratenes Formular');
    await trashResponse(victim);

    const refused = await purgeResponseOf(decoy.id, victim.responseId, admin);
    expect(refused.status).toBe(404);

    // „Nichts passiert" has to be true of the bytes as well as of the row.
    expect(storage.read(victim.fileId)).toBeDefined();
    expect(
      await app().prisma.file.count({ where: { id: victim.fileId } }),
    ).toBe(1);
    expect(await responseCount(victim.responseId)).toBe(1);

    // And the honest address still works.
    expect((await purgeResponse(victim, admin)).status).toBe(204);
  }, 60_000);

  /**
   * **`last_error` does not survive** (a review finding).
   *
   * The worker writes the transport's own message into `last_error`, stripped
   * of credentials and cut to 500 characters — and a rejection typically quotes
   * the address: `550 5.1.1 <anton@…>: Recipient address rejected`. Erasure
   * blanked it only on lines it moved from `queued` to `failed`, so a line that
   * had already failed said `recipient IS NULL` — „geleert" — while carrying
   * the participant's address for the remaining 90 days of the retention window.
   *
   * Measured against the **whole row**, not against the columns the promise
   * names: naming the columns is exactly what let a fifth one through.
   *
   * *Reproduction, measured:* take `lastError` back out of
   * `ERASED_MAIL_LOG_COLUMNS` and this case is red on the `to_jsonb` search.
   */
  it('empties last_error too, so a bounce cannot keep the address', async () => {
    const item = await submission('Unzustellbar');
    const line = await mailRow(item.formId);

    // What Postfix and Exim answer, written the way `MailError` stores it.
    await app().prisma.mailLog.update({
      where: { id: line.id },
      data: {
        status: 'failed',
        attempts: 5,
        nextAttemptAt: null,
        lastError: `550 5.1.1 <${PARTICIPANT}>: Recipient address rejected: User unknown`,
      },
    });

    await trashResponse(item);
    expect((await purgeResponse(item, admin)).status).toBe(204);

    const [row] = await app().prisma.$queryRaw<{ row: unknown }[]>`
      SELECT to_jsonb(m) AS row FROM "mail_log" m WHERE m."id" = ${line.id}::uuid`;
    expect(row).toBeDefined();
    expect(JSON.stringify(row?.row)).not.toContain(PARTICIPANT);

    // …and the operational record the requirement promises to keep is still there.
    const after = await mailRow(item.formId);
    expect(after.status).toBe('failed');
    expect(after.attempts).toBe(5);
    expect(after.lastError).toBeNull();
  }, 60_000);

  /** The same for a form — both destructive statements sit behind the check. */
  it('refuses a form that is not in the Papierkorb, and destroys nothing', async () => {
    const item = await submission('Formular lebendig');

    expect((await purgeForm(item.formId, admin)).status).toBe(404);

    expect(await app().prisma.form.count({ where: { id: item.formId } })).toBe(
      1,
    );
    expect(await responseCount(item.responseId)).toBe(1);
    expect((await mailRow(item.formId)).recipient).toBe(PARTICIPANT);
  }, 60_000);

  /**
   * **Tenant-Isolation** — an organisation cannot destroy another organisation's rows, and the
   * refusal is the one 404 every other form route gives.
   */
  it('answers 404 to another organisation and leaves the rows standing', async () => {
    const item = await submission('Fremde Organisation');
    await trashForm(item.formId);

    expect((await purgeForm(item.formId, betaAdmin)).status).toBe(404);
    expect((await purgeResponse(item, betaAdmin)).status).toBe(404);

    expect(await app().prisma.form.count({ where: { id: item.formId } })).toBe(
      1,
    );
    expect(await responseCount(item.responseId)).toBe(1);
    expect(storage.read(item.fileId)).toBeDefined();
  }, 60_000);

  /**
   * **„Papierkorb leeren" clears only one's own organisation** — the foreign organisation's
   * trash is not an address this API has, so the measurement is that
   * emptying one leaves the other's rows exactly where they were.
   */
  it('empties only the calling Organisation’s Papierkorb', async () => {
    const mine = await submission('Eigenes');
    await trashResponse(mine);

    const theirsBefore = await app().prisma.response.count({
      where: { tenantId: beta.id },
    });

    const emptied = await emptyTrash(admin);
    expect(emptied.status).toBe(200);
    const body = emptied.body as {
      forms: number;
      responses: number;
      failed: number;
    };
    expect(body.responses).toBeGreaterThanOrEqual(1);
    expect(body.failed).toBe(0);

    expect(await responseCount(mine.responseId)).toBe(0);
    expect(
      await app().prisma.response.count({ where: { tenantId: beta.id } }),
    ).toBe(theirsBefore);

    // And it is empty afterwards — the counter the view reads.
    const view = await request(app().server)
      .get(apiPath('/trash'))
      .set('Cookie', cookieHeader(admin));
    expect(view.status).toBe(200);
    const trash = view.body as { forms: unknown[]; responses: unknown[] };
    expect(trash.forms).toHaveLength(0);
    expect(trash.responses).toHaveLength(0);
  }, 120_000);

  // ═════════════════════════════════════════════════════════════════════════
  // „Leeren" must not destroy what the single route refuses (a review finding)
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **The form cap applies to „Papierkorb leeren" as well** (a review finding).
   *
   * The person holds `can_build` and `can_view_responses` **organisation-wide** — the
   * pair the route demands — and is capped on this one form to a role without
   * `can_build`. `DELETE /forms/X/permanent` answers 403 for exactly that
   * reason; the collection route used to answer 204 and destroy X.
   *
   * *Reproduction, measured:* drop the `hiddenFormIdsIn` narrowing from
   * `PermanentDeletionService.emptyTrash` (the state before this fix) and this
   * case is red on `form.count` — the form, its answers, its attachment bytes
   * and its mail log are gone, and the report says `forms: 1`.
   */
  it('leaves a form the caller is capped out of, where the single route says 403', async () => {
    const item = await submission('Gedeckelt ohne Baurecht');
    await trashForm(item.formId);
    await restrict(item.formId, {
      accessRevoked: false,
      cappedGroupId: readOnlyGroupId,
    });

    // The single route, first — this is the answer the collection has to agree
    // with rather than a control that happens to pass.
    expect((await purgeForm(item.formId, capped)).status).toBe(403);

    const emptied = await emptyTrash(capped);
    expect(emptied.status).toBe(200);

    expect(await app().prisma.form.count({ where: { id: item.formId } })).toBe(
      1,
    );
    expect(await responseCount(item.responseId)).toBe(1);
    expect(storage.read(item.fileId)).toBeDefined();
    expect((await mailRow(item.formId)).recipient).toBe(PARTICIPANT);

    // …and it is not reported as „left over" either: the caller may never
    // empty it, so a `remaining` counting it would make „nochmal drücken"
    // advice that never ends.
    const report = emptied.body as PurgeReport;
    expect(report.forms).toBe(0);

    expect((await purgeForm(item.formId, admin)).status).toBe(204);
  }, 120_000);

  /**
   * **And the answers are the sharper case.**
   *
   * `TrashService.view` already keeps the answers of a capped form out of the
   * trash — „wer Antworten nicht sehen darf" must not learn from it that a
   * registration was made and withdrawn. Emptying used to destroy precisely
   * those rows: physically deleted, unrecoverable, and never once shown to the
   * person who deleted them.
   *
   * Both halves are asserted in that order — first that the view withholds it,
   * then that the deletion does not take it.
   */
  it('leaves the answers of a form whose answers it does not even show', async () => {
    const item = await submission('Gedeckelt ohne Antwortrecht');
    await trashResponse(item);
    await restrict(item.formId, {
      accessRevoked: false,
      cappedGroupId: buildOnlyGroupId,
    });

    const view = await request(app().server)
      .get(apiPath('/trash'))
      .set('Cookie', cookieHeader(capped));
    expect(view.status).toBe(200);
    const listed = view.body as { responses: { id: string }[] };
    expect(listed.responses.some((row) => row.id === item.responseId)).toBe(
      false,
    );

    const emptied = await emptyTrash(capped);
    expect(emptied.status).toBe(200);

    expect(await responseCount(item.responseId)).toBe(1);
    expect(storage.read(item.fileId)).toBeDefined();
    expect((await mailRow(item.formId)).recipient).toBe(PARTICIPANT);

    // The single route agrees, from the other side of the same cap.
    expect((await purgeResponse(item, capped)).status).toBe(403);

    await trashForm(item.formId);
    expect((await purgeForm(item.formId, admin)).status).toBe(204);
  }, 120_000);

  /**
   * **And a revoked form** — the `access_revoked` half, which had no
   * case at all before this review.
   *
   * *Reproduction, measured:* removing **both** `formFilter()` calls from
   * `emptyTrash` left all thirteen cases of this file green, which is what a
   * missing case looks like from the inside. Here it is red: the form is gone
   * and the report says `forms: 1`.
   */
  it('leaves a form the caller is revoked from, where the single route says 404', async () => {
    const item = await submission('Zugriff entzogen');
    await trashForm(item.formId);
    await restrict(item.formId, {
      accessRevoked: true,
      cappedGroupId: null,
    });

    // 404 and not 403 — a revocation is byte-identical to an unknown form.
    expect((await purgeForm(item.formId, capped)).status).toBe(404);

    const emptied = await emptyTrash(capped);
    expect(emptied.status).toBe(200);
    expect((emptied.body as PurgeReport).forms).toBe(0);

    expect(await app().prisma.form.count({ where: { id: item.formId } })).toBe(
      1,
    );
    expect(await responseCount(item.responseId)).toBe(1);
    expect(storage.read(item.fileId)).toBeDefined();

    expect((await purgeForm(item.formId, admin)).status).toBe(204);
  }, 120_000);

  // ═════════════════════════════════════════════════════════════════════════
  // The permissions (decision of 2026-08-03)
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **`can_build` alone is not enough** — the half the requirement deliberately accepts for
   * moving a form into the trash, and deliberately does not accept here.
   *
   * *Reproduction:* weaken the three routes to `@RequirePermission('canBuild')`
   * and exactly these three cases go green where 403 is asserted.
   */
  it('refuses a Bearbeiter without can_view_responses on all three routes', async () => {
    const item = await submission('Ohne Antwortrecht');
    await trashResponse(item);

    expect((await purgeResponse(item, builder)).status).toBe(403);
    expect(await responseCount(item.responseId)).toBe(1);

    await trashForm(item.formId);
    expect((await purgeForm(item.formId, builder)).status).toBe(403);
    expect(await app().prisma.form.count({ where: { id: item.formId } })).toBe(
      1,
    );

    expect((await emptyTrash(builder)).status).toBe(403);
    expect(await app().prisma.form.count({ where: { id: item.formId } })).toBe(
      1,
    );
    expect((await mailRow(item.formId)).recipient).toBe(PARTICIPANT);

    // Cleaned up so the „leeren" case above/below is not fed by this one.
    expect((await purgeForm(item.formId, admin)).status).toBe(204);
  }, 120_000);

  /**
   * **`can_view_responses` alone is not enough either** — the other half of the
   * pair, measured the same way.
   *
   * *Reproduction:* weaken the three routes to
   * `@RequirePermission('canViewResponses')` and exactly these go green.
   */
  it('refuses a Leser without can_build on all three routes', async () => {
    const item = await submission('Ohne Baurecht');
    await trashResponse(item);

    expect((await purgeResponse(item, viewer)).status).toBe(403);
    expect(await responseCount(item.responseId)).toBe(1);

    await trashForm(item.formId);
    expect((await purgeForm(item.formId, viewer)).status).toBe(403);
    expect((await emptyTrash(viewer)).status).toBe(403);

    expect(await app().prisma.form.count({ where: { id: item.formId } })).toBe(
      1,
    );
    expect((await mailRow(item.formId)).recipient).toBe(PARTICIPANT);

    expect((await purgeForm(item.formId, admin)).status).toBe(204);
  }, 120_000);

  // ═════════════════════════════════════════════════════════════════════════
  // When the storage does not play along
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **The bytes first, and if they will not go, nothing goes at all** (ADR-0014
   * no. 16).
   *
   * A `remove()` that fails must leave the **visible** half standing: the file
   * row, the answer, the mail log. The refusal is a repeatable 503, not
   * a 500 and not a quiet 204 — and the second half of the case is that
   * pressing again, with the storage working, finishes the job.
   *
   * *Reproduction:* delete the answer row before removing the bytes and this
   * case turns red on `file.count`/`responseCount` — with bytes left on the
   * volume that nothing could ever find again.
   */
  it('deletes nothing when the storage refuses the bytes, and finishes on the retry', async () => {
    const item = await submission('Storage streikt');
    await trashResponse(item);

    storage.failNextRemoval();
    const refused = await purgeResponse(item, admin);
    expect(refused.status).toBe(503);
    expect((refused.body as { message?: string }).message).toBe(
      PURGE_STORAGE_UNAVAILABLE_MESSAGE,
    );

    // Nothing moved — row, answer and the four columns.
    expect(await app().prisma.file.count({ where: { id: item.fileId } })).toBe(
      1,
    );
    expect(await responseCount(item.responseId)).toBe(1);
    expect((await mailRow(item.formId)).recipient).toBe(PARTICIPANT);

    // And the retry finishes it.
    expect((await purgeResponse(item, admin)).status).toBe(204);
    expect(await responseCount(item.responseId)).toBe(0);
    expect(storage.read(item.fileId)).toBeUndefined();
  }, 60_000);

  /**
   * **From the second attachment on, „nichts gelöscht" is wrong** (a review finding).
   *
   * The files go one transaction each and the run stops at the first refusal,
   * so with five attachments and the third one stuck, one and two are gone for
   * good — the JSDoc of `removeAll` said so all along while the sentence shown
   * to the editor said the opposite. Somebody restoring afterwards gets a
   * registration missing part of its attachments, with nothing anywhere saying
   * why.
   *
   * The case the old test could not see: it created exactly **one** attachment,
   * where „nothing was deleted" and „the row was not deleted" are the same
   * sentence. Two, with the **second** removal refused, is what pulls them
   * apart.
   *
   * *Reproduction, measured:* put the old wording back into
   * `PURGE_STORAGE_UNAVAILABLE_MESSAGE` and this case is red on the last
   * assertion, with the first attachment gone exactly as asserted above it.
   */
  it('does not claim „nichts gelöscht" once one of two attachments is already gone', async () => {
    const item = await submission('Zwei Anlagen', 2);
    expect(item.fileIds).toHaveLength(2);
    await trashResponse(item);

    // The first removal goes through, the second does not.
    storage.failRemovalAfter(1);
    const refused = await purgeResponse(item, admin);
    expect(refused.status).toBe(503);

    // Exactly one of the two is irreversibly gone — bytes and row.
    const surviving = item.fileIds.filter(
      (id) => storage.read(id) !== undefined,
    );
    expect(surviving).toHaveLength(1);
    expect(
      await app().prisma.file.count({
        where: { id: { in: [...item.fileIds] } },
      }),
    ).toBe(1);

    // The row itself did stay — that is the half the refusal may promise.
    expect(await responseCount(item.responseId)).toBe(1);
    expect((await mailRow(item.formId)).recipient).toBe(PARTICIPANT);

    // And the sentence says that, and not more.
    const message = (refused.body as { message?: string }).message;
    expect(message).toBe(PURGE_STORAGE_UNAVAILABLE_MESSAGE);
    expect(message).not.toContain('Es wurde nichts endgültig gelöscht');

    // The retry finishes what is left.
    expect((await purgeResponse(item, admin)).status).toBe(204);
    expect(await responseCount(item.responseId)).toBe(0);
  }, 60_000);

  /**
   * **A restore in the middle of the run no longer costs all attachments**
   * (a review finding).
   *
   * The enumeration says „diese Anlagen gehören zu einer Antwort im
   * Papierkorb"; the removals happen afterwards, one transaction each. The
   * window between the two was described as „zwei Bediener in einer Sekunde",
   * and that was the enumeration plus **every** removal — on a network volume,
   * seconds. `ScopedFileDelegate.purgeAttachment` now asks the same condition
   * again under the row's own lock, one statement before the bytes go, which
   * shrinks it to that statement and costs no lock the transaction was not
   * taking anyway.
   *
   * The restore is landed exactly in that window, by parking the **first**
   * removal: what the case then measures is the **second** attachment, the one
   * whose turn comes after the answer is alive again. The first one's bytes are
   * gone either way — that is the irreversible half this design admits to, and
   * it is asserted rather than glossed over.
   *
   * *Reproduction, measured:* remove the second ownership check from
   * `purgeAttachment` and this case is red on the surviving attachment — a live
   * registration missing an attachment, with a 404 telling the caller nothing
   * happened.
   */
  it('keeps the attachments still to come when a restore lands mid-run', async () => {
    const item = await submission('Dazwischen wiederhergestellt', 2);
    await trashResponse(item);

    const gate = storage.holdNextRemoval();
    const purging = purgeResponse(item, admin).then((response) => response);
    await gate.arrived;

    // The editor changes their mind while the first file is being removed.
    const restored = await request(app().server)
      .post(
        apiPath(`/forms/${item.formId}/responses/${item.responseId}/restore`),
      )
      .set(authedMutation(admin));
    expect(restored.status).toBe(204);
    gate.release();

    // The answer is alive, so the deletion matches nothing and says so.
    expect((await purging).status).toBe(404);
    expect(await responseCount(item.responseId)).toBe(1);

    const [first, second] = item.fileIds;
    // Admitted: the one already in flight is gone, bytes and row.
    expect(storage.read(first ?? '')).toBeUndefined();
    // Closed: the one whose turn came after the restore is untouched.
    expect(storage.read(second ?? '')).toBeDefined();
    expect(await app().prisma.file.count({ where: { id: second ?? '' } })).toBe(
      1,
    );
  }, 60_000);

  // ═════════════════════════════════════════════════════════════════════════
  // A trash that is bigger than one call (a review finding)
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **„Papierkorb leeren" takes one batch and says what is left over**
   * (a review finding).
   *
   * A thousand answers used to be a thousand serial transactions inside one
   * HTTP request, against a pool of `DB_POOL_MAX = 10`: a dropped connection
   * did not stop the run, the report was lost, and nothing said how far it had
   * got. Now a call takes at most `TRASH_PURGE_BATCH_SIZE` items and counts
   * what is left, so pressing again continues.
   *
   * The rows are written straight into `response` rather than submitted through
   * the public route — a hundred real submissions would measure the throughput
   * of the fill-in path, which is not what this case is about. What has to be
   * real is the *deletion*, and that goes through the shipped route.
   *
   * *Reproduction, measured:* drop the `take` from both listings (the state
   * before this fix) and the first call empties everything — red on
   * `remaining` and on the second call's `responses`.
   */
  it('empties one batch per call and says how many items are left', async () => {
    await drainTrash();

    const host = await submission('Großer Papierkorb');
    const version = await app().prisma.response.findUniqueOrThrow({
      where: { id: host.responseId },
      select: { formVersionId: true },
    });

    const surplus = 2;
    const total = TRASH_PURGE_BATCH_SIZE + surplus;
    await app().prisma.response.createMany({
      data: Array.from({ length: total }, () => ({
        tenantId: alpha.id,
        formId: host.formId,
        formVersionId: version.formVersionId,
        answers: {},
        deletedAt: new Date(),
      })),
    });

    const first = (await emptyTrash(admin)).body as PurgeReport;
    expect(first.responses).toBe(TRASH_PURGE_BATCH_SIZE);
    expect(first.failed).toBe(0);
    expect(first.remaining).toBe(surplus);

    const second = (await emptyTrash(admin)).body as PurgeReport;
    expect(second.responses).toBe(surplus);
    expect(second.remaining).toBe(0);

    // The host answer was never in the trash and is untouched by both.
    expect(await responseCount(host.responseId)).toBe(1);
  }, 180_000);

  /**
   * One worker run, reported as **what the outside world saw** — the count is
   * taken around the run so a previous case's mail cannot make „nothing went
   * out" arithmetic instead of an observation.
   */
  async function runWorker(): Promise<{ sends: number }> {
    const before = transport.attemptCount;
    await worker.runOnce();
    return { sends: transport.attemptCount - before };
  }
});
