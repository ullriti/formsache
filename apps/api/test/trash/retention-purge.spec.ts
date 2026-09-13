import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  TRASH_PURGE_BATCH_SIZE,
  TRASH_RETENTION_DAYS,
} from '@formsache/shared';
import { Prisma } from '@prisma/client';

import { PermanentDeletionService } from '../../src/trash/permanent-deletion.service';
import { RetentionPurgeService } from '../../src/trash/purge/retention-purge.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { MutableClock } from '../mail/mail-test-context';
import {
  TEST_PUBLIC_BASE_URL,
  TEST_SYSTEM_SMTP_BLOCK,
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import {
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, cookieHeader, openSession } from '../support/http';
import { InMemoryFileStorage } from '../support/in-memory-file-storage';

/**
 * **After 30 days the application clears up by itself** .
 *
 * ## Everything is created through the routes, and that is not decoration
 *
 * `deleted_at` is stamped from the injected clock on every one of the three
 * paths — `DELETE /api/forms/:id`, `DELETE /api/forms/:id/responses/:rid` and
 * `DELETE /api/admin/tenants/:id`. So a suite can *produce*
 * the state it measures instead of writing timestamps into the tables by hand,
 * which would be measuring its own SQL against its own SQL (the trap
 * „dritte Falle" names).
 *
 * ## Measured at the boundary
 *
 * A row aged 200 days survives no limit between 1 and 200 and would be deleted
 * by a purge that keeps nothing just as much as by one that keeps a month. Every
 * case here therefore sits **one day either side** of the promise: 29 days must
 * still be there, 31 must be gone.
 *
 * ## Counted without a filter
 *
 * „Physically gone, not marked" is asked with `count(*)` over the table rather
 * than of a route — a route that filters `deleted_at` answers the same for a
 * soft delete, which is the implementation the requirement rules out.
 *
 * ## Reproductions, measured on 2026-08-03 — see each case
 */

const PASSWORD = 'test-password-e6';
const MS_PER_DAY = 86_400_000;

/** One day past the promise — must be gone. */
const OVER = TRASH_RETENTION_DAYS + 1;
/** One day short of it — must survive. */
const UNDER = TRASH_RETENTION_DAYS - 1;

/**
 * An interval no test can wait out — an hour, where the shipped value is a day.
 * Something that disappears under it disappeared at start-up or not at all.
 */
const HUGE_INTERVAL_MS = 3_600_000;
const WAIT_BUDGET_MS = 5_000;

const PAGE = '019ffe10-0000-7000-8000-0000000000a0';
const NAME_QUESTION = '019ffe10-0000-7000-8000-000000000001';
const FILE_QUESTION = '019ffe10-0000-7000-8000-000000000003';

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
          id: FILE_QUESTION,
          type: 'file',
          label: 'Nachweis',
          maxFiles: 2,
        },
      ],
    },
  ],
};

/** A minimal PNG — the upload derives the type from the signature, not the name. */
function png(bytes: number): Buffer {
  const header = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
  ]);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, bytes - 16), 7)]);
}

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

async function waitUntil(
  condition: () => Promise<boolean>,
  budgetMs = WAIT_BUDGET_MS,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await condition()) {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10).unref();
    });
  }
}

describe('der 30-Tage-Purge des Papierkorbs', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp;
  let clock: MutableClock;
  let storage: InMemoryFileStorage;

  /** The living organisation whose forms and answers the first cases delete. */
  let home: TenantFixture;
  let admin: string;
  let superadmin: string;

  /** The instant every case counts its 29 and 31 days from. */
  const DELETED_AT = new Date('2026-09-01T09:00:00.000Z');
  const START = new Date('2026-08-03T12:00:00.000Z');

  const app = (): TestApp => testApp;
  const purge = (): RetentionPurgeService =>
    testApp.app.get(RetentionPurgeService);

  beforeAll(async () => {
    database = await acquireTestDatabase();
    storage = new InMemoryFileStorage();
    clock = new MutableClock(START);
    testApp = await createTestApp({
      databaseUrl: database.url,
      /*
       * Since ADR-0024 the instance's mail server is one of the preconditions
       * of creating: to create a person means to send them an invitation.
       * Without it `POST /api/tenant/users` answered with 422, and the case
       * „die Adresse einer uneingelösten Einladung ist wieder frei" would not
       * even get as far as its invitation.
       */
      systemMail: {
        publicBaseUrl: TEST_PUBLIC_BASE_URL,
        smtp: TEST_SYSTEM_SMTP_BLOCK,
      },
      env: { TRUST_PROXY_HOPS: 1 },
      storage,
      clock,
    });

    home = await createTenant(testApp.prisma, 'HEIMAT');
    const adminUser = await createUser(testApp.prisma, {
      email: 'admin@heimat.invalid',
      password: PASSWORD,
      tenants: [home],
    });
    admin = await openSession(testApp, adminUser.id, home.id);

    const root = await createUser(testApp.prisma, {
      email: 'root@example.org',
      password: PASSWORD,
      isSuperadmin: true,
    });
    superadmin = await openSession(testApp, root.id, null);
  }, 240_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  // ─── fixtures, through the real routes ────────────────────────────────────

  async function publishedForm(
    session: string,
    title: string,
  ): Promise<{ id: string; slug: string }> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(session))
      .send({ title });
    expect(created.status).toBe(201);
    const form = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };

    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(session))
      .send({ title, definition, revision: form.revision });
    expect(saved.status).toBe(200);

    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(session))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    return { id: form.id, slug: form.publicSlug };
  }

  /** One submission, optionally with an attachment whose bytes really exist. */
  async function submit(
    slug: string,
    formId: string,
    withFile = false,
  ): Promise<{ responseId: string; fileId: string | undefined }> {
    let ref: string | undefined;
    if (withFile) {
      const uploaded = await request(app().server)
        .post(apiPath(`/public/forms/${slug}/files`))
        .set('X-Forwarded-For', ownAddress())
        .set('Content-Type', 'application/octet-stream')
        .set('X-File-Name', encodeURIComponent('nachweis.png'))
        .send(png(64));
      expect(uploaded.status).toBe(201);
      ref = (uploaded.body as { ref: string }).ref;
    }

    const sent = await request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({
        answers: {
          [NAME_QUESTION]: 'Anton Aktiv',
          ...(ref === undefined
            ? {}
            : { [FILE_QUESTION]: { files: [{ ref, name: 'nachweis.png' }] } }),
        },
      });
    expect(sent.status).toBe(200);

    const response = await app().prisma.response.findFirstOrThrow({
      where: { formId },
      orderBy: { submittedAt: 'desc' },
      select: { id: true },
    });
    const file =
      ref === undefined
        ? undefined
        : await app().prisma.file.findFirstOrThrow({
            where: { publicRef: ref },
            select: { id: true },
          });
    return { responseId: response.id, fileId: file?.id };
  }

  async function trashForm(session: string, formId: string): Promise<void> {
    const deleted = await request(app().server)
      .delete(apiPath(`/forms/${formId}`))
      .set(authedMutation(session));
    expect(deleted.status).toBe(204);
  }

  async function trashResponse(
    session: string,
    formId: string,
    responseId: string,
  ): Promise<void> {
    const deleted = await request(app().server)
      .delete(apiPath(`/forms/${formId}/responses/${responseId}`))
      .set(authedMutation(session));
    expect(deleted.status).toBe(204);
  }

  async function trashTenant(id: string, name: string): Promise<void> {
    const deleted = await request(app().server)
      .delete(apiPath(`/admin/tenants/${id}`))
      .set(authedMutation(superadmin))
      .send({ confirmName: name });
    expect(deleted.status).toBe(204);
  }

  /** Rows still physically present, asked without any `where` on `deleted_at`. */
  function formCount(id: string): Promise<number> {
    return app().prisma.form.count({ where: { id } });
  }

  function daysAfterDeletion(days: number): Date {
    return new Date(DELETED_AT.getTime() + days * MS_PER_DAY);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // the evidence — 29 days stays, 31 days is gone
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * *Reproduction:* replacing the listing's `lte: cutoff` with `not: null` →
   * this case red at the 29-day assertion (the form is gone a day too early).
   */
  it('der Nachweis — ein Formular: 29 Tage bleibt, 31 Tage ist weg', async () => {
    const form = await publishedForm(admin, 'Bestandsmeldung');
    clock.set(DELETED_AT);
    await trashForm(admin, form.id);

    clock.set(daysAfterDeletion(UNDER));
    const early = await purge().runOnce();
    expect(early.forms).toBe(0);
    expect(await formCount(form.id)).toBe(1);

    clock.set(daysAfterDeletion(OVER));
    const late = await purge().runOnce();
    expect(late.forms).toBe(1);
    expect(await formCount(form.id)).toBe(0);
    // Its version went with it — the cascade, not a second deletion path.
    expect(
      await app().prisma.formVersion.count({ where: { formId: form.id } }),
    ).toBe(0);
    // And nothing is left over for the next run.
    expect(late.remaining).toBe(0);
    expect(late.failed).toBe(0);
  }, 180_000);

  /**
   * An answer deleted **in its own right**, i.e. whose form is still alive.
   *
   * *Reproduction:* dropping the `response` phase of `runOnce` → red here and
   * green in the form case above, which is what makes the two separate cases
   * rather than one.
   */
  it('der Nachweis — eine Antwort: 29 Tage bleibt, 31 Tage ist weg', async () => {
    const form = await publishedForm(admin, 'Sterbefallmeldung');
    const { responseId } = await submit(form.slug, form.id);

    clock.set(DELETED_AT);
    await trashResponse(admin, form.id, responseId);

    clock.set(daysAfterDeletion(UNDER));
    expect((await purge().runOnce()).responses).toBe(0);
    expect(
      await app().prisma.response.count({ where: { id: responseId } }),
    ).toBe(1);

    clock.set(daysAfterDeletion(OVER));
    expect((await purge().runOnce()).responses).toBe(1);
    expect(
      await app().prisma.response.count({ where: { id: responseId } }),
    ).toBe(0);
    // The form it belonged to is untouched — only the answer was in the
    // trash.
    expect(await formCount(form.id)).toBe(1);

    await trashForm(admin, form.id);
    await purge().runOnce();
  }, 180_000);

  /**
   * A whole organisation, with the cascade — the job's own listing, not
   * `PermanentDeletionService.deleteTenant` called by hand (which is what
   * `test/admin/tenant-trash.spec.ts` measures).
   *
   * *Reproduction:* dropping the `tenant` phase of `runOnce` → red here while
   * the two cases above stay green.
   */
  it('der Nachweis — eine Organisation: 29 Tage bleibt, 31 Tage ist weg', async () => {
    const doomed = await createTenant(app().prisma, 'FRIST');
    const user = await createUser(app().prisma, {
      email: 'letzter@frist.invalid',
      password: PASSWORD,
      tenants: [doomed],
    });
    const editor = await openSession(testApp, user.id, doomed.id);
    await publishedForm(editor, 'Jahrestagung');

    clock.set(DELETED_AT);
    await trashTenant(doomed.id, 'Organisation FRIST');

    clock.set(daysAfterDeletion(UNDER));
    expect((await purge().runOnce()).tenants).toBe(0);
    expect(await app().prisma.tenant.count({ where: { id: doomed.id } })).toBe(
      1,
    );

    clock.set(daysAfterDeletion(OVER));
    const late = await purge().runOnce();
    expect(late.tenants).toBe(1);

    const where = { tenantId: doomed.id };
    expect(await app().prisma.tenant.count({ where: { id: doomed.id } })).toBe(
      0,
    );
    expect(await app().prisma.group.count({ where })).toBe(0);
    expect(await app().prisma.membership.count({ where })).toBe(0);
    expect(await app().prisma.form.count({ where })).toBe(0);
    expect(await app().prisma.formVersion.count({ where })).toBe(0);
  }, 180_000);

  /**
   * **Across tenants** : one run reaches two
   * different organisations.
   *
   * A purge that had somehow ended up scoped to one organisation would pass every case
   * above — each of them has one — and fail exactly here.
   *
   * *Reproduction:* restricting the form listing to a single `tenant_id` → red
   * here, green everywhere else.
   */
  it('ein Lauf räumt über Organisationsgrenzen hinweg auf', async () => {
    const other = await createTenant(app().prisma, 'NACHBAR');
    const neighbour = await createUser(app().prisma, {
      email: 'admin@nachbar.invalid',
      password: PASSWORD,
      tenants: [other],
    });
    const neighbourAdmin = await openSession(testApp, neighbour.id, other.id);

    const mine = await publishedForm(admin, 'Meins');
    const theirs = await publishedForm(neighbourAdmin, 'Ihres');

    clock.set(DELETED_AT);
    await trashForm(admin, mine.id);
    await trashForm(neighbourAdmin, theirs.id);

    clock.set(daysAfterDeletion(OVER));
    const run = await purge().runOnce();
    expect(run.forms).toBe(2);
    expect(await formCount(mine.id)).toBe(0);
    expect(await formCount(theirs.id)).toBe(0);
  }, 180_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // The organisation is the outer bracket (a review finding)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * One organisation whose own 30 days are **not** up yet, holding a form and an answer
   * whose 30 days **are**.
   *
   * The form and the answer are put into the trash on day 0, the organisation
   * follows on day 5. Before this change the run of day 31 destroyed both
   * physically while the organisation was still standing and still restorable — which
   * is the promise of the evidence („restored, everything works
   * again") broken from the inside, with nothing anywhere saying what
   * was missing.
   *
   * The **answer** is deliberately one under a *living* form: its exclusion
   * cannot be inherited from the form's, so a fix that only taught `dueForms`
   * about the organisation would leave it exposed.
   *
   * *Reproduction:* dropping `tenant: { deletedAt: null }` from `dueForms` →
   * red at the form; dropping it from `dueResponses` → red at the answer.
   * Measured on 2026-08-03.
   */
  it('review-fund 6 — was in einem Papierkorb-Organisation liegt, wartet auf dessen Frist', async () => {
    const doomed = await createTenant(app().prisma, 'KLAMMER');
    const member = await createUser(app().prisma, {
      email: 'edit@klammer.invalid',
      password: PASSWORD,
      tenants: [doomed],
    });
    const editor = await openSession(testApp, member.id, doomed.id);

    const trashed = await publishedForm(editor, 'Früh im Papierkorb');
    const living = await publishedForm(editor, 'Lebendiges Formular');
    const { responseId } = await submit(living.slug, living.id);

    // Day 0: the contents go into the trash.
    clock.set(DELETED_AT);
    await trashForm(editor, trashed.id);
    await trashResponse(editor, living.id, responseId);

    // Day 5: the organisation follows them.
    clock.set(daysAfterDeletion(5));
    await trashTenant(doomed.id, 'Organisation KLAMMER');

    // Day 31: the contents' own 30 days are up, the organisation's are not (day 35).
    clock.set(daysAfterDeletion(OVER));
    const early = await purge().runOnce();
    expect(early.tenants).toBe(0);
    expect(early.forms).toBe(0);
    expect(early.responses).toBe(0);
    // Physically still there — asked without any filter on `deleted_at`.
    expect(await formCount(trashed.id)).toBe(1);
    expect(
      await app().prisma.response.count({ where: { id: responseId } }),
    ).toBe(1);
    expect(await app().prisma.tenant.count({ where: { id: doomed.id } })).toBe(
      1,
    );
    // And they are not reported as outstanding either: nothing is going to
    // collect them until their organisation is due, so „remaining" must not name them.
    expect(early.remaining).toBe(0);

    // Day 36: the organisation's own 30 days are up, and everything goes in its
    // cascade — as one item, not as three.
    clock.set(daysAfterDeletion(TRASH_RETENTION_DAYS + 6));
    const late = await purge().runOnce();
    expect(late.tenants).toBe(1);
    expect(late.forms).toBe(0);
    expect(late.responses).toBe(0);
    expect(await formCount(trashed.id)).toBe(0);
    expect(await formCount(living.id)).toBe(0);
    expect(
      await app().prisma.response.count({ where: { id: responseId } }),
    ).toBe(0);
  }, 240_000);

  /**
   * The other direction of the same decision, and the reason it was taken: the
   * organisation comes **back**, and what was in its trash is still there to be
   * restored.
   *
   * *Reproduction:* dropping `tenant: { deletedAt: null }` from `dueForms` →
   * red at the restore, which answers 404 for a form the run destroyed while
   * its organisation was still restorable.
   */
  it('review-fund 6 — eine wiederhergestellte Organisation bringt ihren Papierkorb mit', async () => {
    const doomed = await createTenant(app().prisma, 'RUECKKEHR');
    const member = await createUser(app().prisma, {
      email: 'edit@rueckkehr.invalid',
      password: PASSWORD,
      tenants: [doomed],
    });
    const editor = await openSession(testApp, member.id, doomed.id);
    const form = await publishedForm(editor, 'Kommt zurück');

    clock.set(DELETED_AT);
    await trashForm(editor, form.id);
    clock.set(daysAfterDeletion(5));
    await trashTenant(doomed.id, 'Organisation RUECKKEHR');

    clock.set(daysAfterDeletion(OVER));
    await purge().runOnce();

    // Day 32 — inside the organisation's 30 days: it comes back …
    clock.set(daysAfterDeletion(TRASH_RETENTION_DAYS + 2));
    const restored = await request(app().server)
      .post(apiPath(`/admin/tenants/${doomed.id}/restore`))
      .set(authedMutation(superadmin));
    expect(restored.status).toBe(204);

    // … and the form it held is still in its trash, i.e. restorable.
    const back = await request(app().server)
      .post(apiPath(`/forms/${form.id}/restore`))
      .set(authedMutation(editor));
    expect(back.status).toBe(204);
    expect(await formCount(form.id)).toBe(1);

    // The price of the outer bracket, measured rather than claimed: the form
    // stood in the trash for 32 days instead of 30 — and was restorable
    // for all of them.
    const now = await app().prisma.form.findUniqueOrThrow({
      where: { id: form.id },
      select: { deletedAt: true },
    });
    expect(now.deletedAt).toBeNull();
  }, 240_000);

  /**
   * **Idempotent**, and the return value is what makes that checkable: a second
   * run answering zeroes is what tells „there was nothing left" apart from „it
   * fell over on the way in".
   */
  it('ein zweiter Lauf löscht nichts und meldet nichts Offenes', async () => {
    const form = await publishedForm(admin, 'Zweimal');
    clock.set(DELETED_AT);
    await trashForm(admin, form.id);
    clock.set(daysAfterDeletion(OVER));

    expect((await purge().runOnce()).forms).toBe(1);

    const again = await purge().runOnce();
    expect(again).toMatchObject({
      tenants: 0,
      forms: 0,
      responses: 0,
      accounts: 0,
      failed: 0,
      remaining: 0,
    });
  }, 180_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // the specification — the people a deleted organisation leaves homeless
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * **(a)** A member of the purged organisation and of nothing else is out of `user`
   * and cannot sign in any more.
   *
   * The login is asked *through the route*, because that is the half the
   * security review found: `AuthService.login` does not require a
   * membership, so „the person no longer has an organisation" would not have stopped it —
   * only the row being gone does.
   *
   * *Reproduction:* removing the account sweep from `purgeTenants` → red at the
   * `user` count **and** at the login, which then answers 200.
   */
  it('die Spezifikation Nr. 68 (a) — wer nur in der gelöschten Organisation war, ist weg und kommt nicht mehr hinein', async () => {
    const doomed = await createTenant(app().prisma, 'HEIMATLOS');
    const lonely = await createUser(app().prisma, {
      email: 'nur-hier@heimatlos.invalid',
      password: PASSWORD,
      tenants: [doomed],
    });

    // The account works before the purge — otherwise „can no longer sign in"
    // would be satisfied by an account that never could.
    const before = await request(app().server)
      .post(apiPath('/auth/login'))
      .send({ email: lonely.email, password: PASSWORD });
    expect(before.status).toBe(200);

    clock.set(DELETED_AT);
    await trashTenant(doomed.id, 'Organisation HEIMATLOS');
    clock.set(daysAfterDeletion(OVER));

    const run = await purge().runOnce();
    expect(run.tenants).toBe(1);
    expect(run.accounts).toBe(1);

    expect(await app().prisma.user.count({ where: { id: lonely.id } })).toBe(0);
    const after = await request(app().server)
      .post(apiPath('/auth/login'))
      .send({ email: lonely.email, password: PASSWORD });
    expect(after.status).toBe(401);
  }, 180_000);

  /**
   * **(b) — the most dangerous row of this package.**
   *
   * Somebody who is also in **another** organisation is not touched, and goes on
   * working there. The other organisation is a **living** one, exactly as the requirement
   * demands: with two doomed organisations the case would go green even without the
   * condition, because both memberships would be gone by the end of the run.
   *
   * The session is opened *before* the purge and used *after* it, so what is
   * measured is the account surviving rather than a fresh login papering over a
   * recreated row.
   *
   * *Reproduction:* dropping `memberships: { none: {} }` from the sweep's
   * `where` → **red**: the account is gone (`0` instead of `1`), and the request
   * against the living organisation answers 401 instead of 200. Measured on 2026-08-03.
   */
  it('die Spezifikation Nr. 68 (b) — wer noch in einer anderen Organisation ist, bleibt unangetastet', async () => {
    const doomed = await createTenant(app().prisma, 'ZWEITWOHNSITZ');
    const alive = await createTenant(app().prisma, 'LEBENDIG');
    const both = await createUser(app().prisma, {
      email: 'beides@example.invalid',
      password: PASSWORD,
      tenants: [doomed, alive],
    });
    const session = await openSession(testApp, both.id, alive.id);

    clock.set(DELETED_AT);
    await trashTenant(doomed.id, 'Organisation ZWEITWOHNSITZ');
    clock.set(daysAfterDeletion(OVER));

    const run = await purge().runOnce();
    expect(run.tenants).toBe(1);
    // Nobody was homeless — the one member had somewhere else to be.
    expect(run.accounts).toBe(0);

    expect(await app().prisma.user.count({ where: { id: both.id } })).toBe(1);
    // The membership in the living organisation is untouched …
    expect(
      await app().prisma.membership.count({
        where: { userId: both.id, tenantId: alive.id },
      }),
    ).toBe(1);
    // … and the person goes on working there, with the session they already
    // had.
    const listing = await request(app().server)
      .get(apiPath('/forms'))
      .set('Cookie', cookieHeader(session));
    expect(listing.status).toBe(200);
  }, 180_000);

  /**
   * **(c)** A superadmin needs no membership at all, so
   * „no membership" is their normal state and not homelessness.
   *
   * The fixture makes them a member of the doomed organisation, because that is the
   * only way they enter the sweep's candidate list in the first place — a
   * superadmin who was never in the organisation is not a case, it is an absence.
   *
   * *Reproduction:* dropping `isSuperadmin: false` from the sweep's `where` →
   * red, and with it the installation's last administrator gone.
   */
  it('the specification Nr. 68 (c) — ein Superadmin ohne Mitgliedschaft bleibt', async () => {
    const doomed = await createTenant(app().prisma, 'ROOTBUND');
    const root = await createUser(app().prisma, {
      email: 'zweitroot@example.org',
      password: PASSWORD,
      isSuperadmin: true,
      tenants: [doomed],
    });

    clock.set(DELETED_AT);
    await trashTenant(doomed.id, 'Organisation ROOTBUND');
    clock.set(daysAfterDeletion(OVER));

    const run = await purge().runOnce();
    expect(run.tenants).toBe(1);
    expect(run.accounts).toBe(0);

    expect(await app().prisma.user.count({ where: { id: root.id } })).toBe(1);
    // And they have no membership left anywhere — i.e. the case really is „a
    // superadmin without a membership" and not „one who is still somewhere
    // else".
    expect(
      await app().prisma.membership.count({ where: { userId: root.id } }),
    ).toBe(0);
  }, 180_000);

  /**
   * **(d)** The address of an unclaimed invitation is free again.
   *
   * `user.email` is unique installation-wide, so an invitation nobody has
   * redeemed occupies the address for every organisation — and until this purge existed
   * no route ever released it again (ADR-0012). The measurement is the
   * refusal turning into a success: the same address is invited into a
   * **living** organisation before and after the purge, 409 then 201.
   *
   * *Reproduction:* removing the account sweep → the second invitation answers
   * 409 again and this case is red.
   */
  it('die Spezifikation Nr. 68 (d) — die Adresse einer uneingelösten Einladung ist wieder frei', async () => {
    const doomed = await createTenant(app().prisma, 'EINLADEND');
    const alive = await createTenant(app().prisma, 'AUFNEHMEND');
    // `POST /api/tenant/users` refuses `kind: 'oidc'` for an organisation with SSO
    // switched off, and stamps the invitation with the organisation's **own** issuer
    // (ADR-0012). Two columns of the fixture rather than a walk through the
    // OIDC configuration route, whose own requirements are covered elsewhere — what this case
    // measures is the address, not the configuration.
    await app().prisma.tenant.updateMany({
      where: { id: { in: [doomed.id, alive.id] } },
      data: { oidcEnabled: true, oidcIssuer: 'https://idp.example.org' },
    });
    const inviter = await createUser(app().prisma, {
      email: 'admin@einladend.invalid',
      password: PASSWORD,
      tenants: [doomed, alive],
    });
    const there = await openSession(testApp, inviter.id, doomed.id);
    const here = await openSession(testApp, inviter.id, alive.id);

    const address = 'eingeladen@example.invalid';
    const invite = (session: string, tenant: TenantFixture) =>
      request(app().server)
        .post(apiPath('/tenant/users'))
        .set(authedMutation(session))
        .send({
          kind: 'oidc',
          email: address,
          name: 'Eingeladene Person',
          groupId: tenant.adminGroupId,
        });

    expect((await invite(there, doomed)).status).toBe(201);
    // The address is taken installation-wide — the state the purge has to end.
    expect((await invite(here, alive)).status).toBe(409);

    clock.set(DELETED_AT);
    await trashTenant(doomed.id, 'Organisation EINLADEND');
    clock.set(daysAfterDeletion(OVER));

    const run = await purge().runOnce();
    expect(run.tenants).toBe(1);
    // The invited person **and** nobody else: `inviter` is still in the living
    // organisation and must not be counted here.
    expect(run.accounts).toBe(1);
    expect(await app().prisma.user.count({ where: { id: inviter.id } })).toBe(
      1,
    );

    expect((await invite(here, alive)).status).toBe(201);
  }, 180_000);

  /**
   * **(e)** Two due organisations in the **same run**, with one person in both.
   *
   * The interesting half is the **first** organisation: its sweep runs while the second
   * membership is still standing, so it must leave the account alone — and the
   * second organisation, later in the same run, must then take it. A sweep that asked
   * „was this person a member of the organisation just deleted" instead of „does
   * this account still belong to somebody" would delete them at the first organisation.
   *
   * **The end state does not tell those two apart, and that was measured**: the
   * account is gone either way, and `accounts` is `1` either way (the second
   * sweep then simply matches nothing). So the case observes the state *in the
   * middle of the run* — `user.count` taken at the start of each `deleteTenant`
   * call. The second observation is the assertion.
   *
   * *Reproduction:* dropping `memberships: { none: {} }` from the sweep → red
   * at `observed`, which becomes `[1, 0]`. Measured on 2026-08-03; the same
   * mutation leaves every assertion about the end state green, which is why
   * they are not the assertion.
   */
  it('die Spezifikation Nr. 68 (e) — zwei fällige Organisationen in einem Lauf, eine Person in beiden', async () => {
    const first = await createTenant(app().prisma, 'ZUERST');
    const second = await createTenant(app().prisma, 'DANACH');
    const both = await createUser(app().prisma, {
      email: 'in-beiden@example.invalid',
      password: PASSWORD,
      tenants: [first, second],
    });

    clock.set(DELETED_AT);
    await trashTenant(first.id, 'Organisation ZUERST');
    await trashTenant(second.id, 'Organisation DANACH');
    clock.set(daysAfterDeletion(OVER));

    const permanent = testApp.app.get(PermanentDeletionService);
    const original = permanent.deleteTenant.bind(permanent);
    const observed: number[] = [];
    const spy = vi
      .spyOn(permanent, 'deleteTenant')
      .mockImplementation(async (scope, cutoff) => {
        observed.push(
          await app().prisma.user.count({ where: { id: both.id } }),
        );
        return original(scope, cutoff);
      });

    let run: Awaited<ReturnType<RetentionPurgeService['runOnce']>>;
    try {
      run = await purge().runOnce();
    } finally {
      spy.mockRestore();
    }

    expect(run.tenants).toBe(2);
    // Before the first organisation, and — the point — before the second: the account
    // survived the first sweep because somebody was still holding it.
    expect(observed).toEqual([1, 1]);
    // Once, not twice: the account is one row, and it only became homeless
    // with the second organisation.
    expect(run.accounts).toBe(1);
    expect(await app().prisma.user.count({ where: { id: both.id } })).toBe(0);
  }, 180_000);

  /**
   * **(f) — this case changed its sign with a review finding.**
   *
   * A `user` with **no membership at all** that was never in any deleted organisation.
   * The review wrote this case to prove it *stays* — the sweep only knew
   * accounts it had read out of an organisation it had just purged, so nothing could
   * ever reach this row. It now proves the opposite, and the reason is not that
   * the guard got weaker:
   *
   * Since **the specification**, „an account without a membership and without
   * superadmin rights" is no longer a state this application leaves standing —
   * *Person entfernen* deletes the account in the same transaction in which
   * the last membership goes. Both doors therefore lead into the same state,
   * and an account that stands there all the same is a **remainder**: the
   * purge that broke off in between (a review finding), or a row from the time
   * before. The reconciliation at the end of every run is exactly the same
   * question, asked one last time — that is why it is deleted here, and that
   * is why this is not a third rule.
   *
   * The superadmin next to it is in the same state and stays: they are the
   * condition that separates the reconciliation from deleting „everything
   * without a membership".
   *
   * *Reproduction:* dropping the closing reconciliation from `runOnce` → red
   * (the account is still there and `accounts` is `0`), while every case above
   * stays green — i.e. no listing of this job ever reaches this row.
   */
  it('review-fund 1 — ein Konto ohne jede Mitgliedschaft geht im Abgleich, ein Superadmin nicht', async () => {
    const stranded = await createUser(app().prisma, {
      email: 'niemandes@example.invalid',
      password: PASSWORD,
    });
    const rootWithout = await createUser(app().prisma, {
      email: 'drittroot@example.org',
      password: PASSWORD,
      isSuperadmin: true,
    });

    // Nothing is due — no organisation, no form, no answer. The account is the whole
    // of what this run has to find, and it finds it without a candidate list.
    const run = await purge().runOnce();
    expect(run.tenants).toBe(0);
    expect(run.accounts).toBe(1);
    expect(run.failed).toBe(0);
    expect(await app().prisma.user.count({ where: { id: stranded.id } })).toBe(
      0,
    );
    expect(
      await app().prisma.user.count({ where: { id: rootWithout.id } }),
    ).toBe(1);
    // Counted afterwards: nothing homeless is left over.
    expect(run.remaining).toBe(0);

    await app().prisma.user.delete({ where: { id: rootWithout.id } });
  }, 180_000);

  /**
   * **The run is resumable — and that is the reason for the reconciliation**
   * (a review finding).
   *
   * The organisation's `DELETE` commits, and the account's is a **separate, later**
   * statement. This case makes that second statement fail once, which is the
   * cheap stand-in for everything that can happen in that gap: a lost
   * connection, a `SIGKILL`, an exception the tick's own `catch` swallows.
   * Afterwards the organisation is gone, so **no listing of this job can ever name that
   * account again** — the candidate list is derived from an organisation that no longer
   * exists.
   *
   * Two things are measured at once, and they are the two halves of the
   * finding:
   *
   * - the failure is **counted** (`failed`), where it used to increment
   *   nothing — a run in which every account refused reported `accounts: 0,
   *   failed: 0` and logged a clean pass;
   * - the closing reconciliation **finds the account anyway**, without a
   *   candidate.
   *
   * *Reproduction:* dropping the reconciliation from `runOnce` → red, with the
   * account still in `user` and `accounts` at `0` — i.e. exactly the state that
   * used to be permanent and invisible.
   */
  it('review-fund 1 — ein gescheitertes Konten-DELETE zählt, und der Abgleich holt es nach', async () => {
    const doomed = await createTenant(app().prisma, 'ABBRUCH');
    const lonely = await createUser(app().prisma, {
      email: 'nur-hier@abbruch.invalid',
      password: PASSWORD,
      tenants: [doomed],
    });

    clock.set(DELETED_AT);
    await trashTenant(doomed.id, 'Organisation ABBRUCH');
    clock.set(daysAfterDeletion(OVER));

    // The **first** `user.deleteMany` of the run is the candidate sweep; the
    // second is the reconciliation. Only the first one is refused.
    const spy = vi.spyOn(app().prisma.user, 'deleteMany').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Connection closed', {
        code: 'P1017',
        clientVersion: 'test',
      }),
    );

    let run: Awaited<ReturnType<RetentionPurgeService['runOnce']>>;
    try {
      run = await purge().runOnce();
    } finally {
      spy.mockRestore();
    }

    // The organisation went regardless — its `DELETE` had already committed.
    expect(run.tenants).toBe(1);
    // The refusal is visible instead of silent …
    expect(run.failed).toBe(1);
    // … and the account is gone all the same, found by the phase that needs no
    // candidate.
    expect(run.accounts).toBe(1);
    expect(await app().prisma.user.count({ where: { id: lonely.id } })).toBe(0);
    expect(run.remaining).toBe(0);
  }, 180_000);

  /**
   * **(g)** Somebody joins a **living** organisation between the run reading the
   * doomed organisation's members and the sweep asking about them.
   *
   * That window is real: `membersOf` runs before the organisation's `DELETE`, the
   * sweep after it. What keeps it harmless is that „does this account still
   * belong to somebody" is asked **at the sweep** and as a condition of the statement
   * that acts — never derived from the list that was read a moment earlier.
   *
   * The join is staged by letting `deleteTenant` do its real work and then
   * writing the membership, which puts it exactly in the gap.
   *
   * *Reproduction:* letting the sweep delete by `id` alone — i.e. „was a member
   * of the deleted organisation" instead of „still belongs to somebody" → **red** here
   * (and at (b), (c) and (d)). Measured on 2026-08-03.
   *
   * Honest about one mutation that stayed **green**: reading the two conditions
   * into an `if` immediately before an unconditional `DELETE`. This case cannot
   * see that difference — its staged join commits before the sweep is entered
   * at all, so a re-read at that moment finds it too. What such an `if` costs
   * is a membership committing between *its own* read and its `DELETE`, a
   * window of one statement that no integration test can hit reliably. The
   * reason both conditions stay in the `where` is written at
   * {@link deleteHomelessAccount} and is an argument, not a measurement.
   */
  it('die Spezifikation Nr. 68 (g) — ein Beitritt zwischen Lesen und Sweep rettet das Konto', async () => {
    const doomed = await createTenant(app().prisma, 'DAZWISCHEN');
    const alive = await createTenant(app().prisma, 'AUFFANG');
    const person = await createUser(app().prisma, {
      email: 'beitritt@example.invalid',
      password: PASSWORD,
      tenants: [doomed],
    });

    clock.set(DELETED_AT);
    await trashTenant(doomed.id, 'Organisation DAZWISCHEN');
    clock.set(daysAfterDeletion(OVER));

    const permanent = testApp.app.get(PermanentDeletionService);
    const original = permanent.deleteTenant.bind(permanent);
    const spy = vi
      .spyOn(permanent, 'deleteTenant')
      .mockImplementation(async (scope, cutoff) => {
        const outcome = await original(scope, cutoff);
        // The join lands here: after the organisation is gone, before the sweep asks.
        await app().prisma.membership.create({
          data: {
            tenantId: alive.id,
            userId: person.id,
            groupId: alive.adminGroupId,
          },
        });
        return outcome;
      });

    let run: Awaited<ReturnType<RetentionPurgeService['runOnce']>>;
    try {
      run = await purge().runOnce();
    } finally {
      spy.mockRestore();
    }

    expect(run.tenants).toBe(1);
    expect(run.accounts).toBe(0);
    expect(await app().prisma.user.count({ where: { id: person.id } })).toBe(1);
    // And the closing reconciliation does not take them either — it asks the
    // same question, and the answer is the same.
    expect(
      await app().prisma.membership.count({ where: { userId: person.id } }),
    ).toBe(1);
  }, 180_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // A failing item does not end the run
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The lesson of the file purge, on a whole installation: a form
   * whose attachment the storage refuses must not take the rest of the run with
   * it.
   *
   * The refused form is deleted **first** (`ORDER BY deleted_at`), which is the
   * arrangement that used to freeze the purge for everybody: the
   * longest-failing item is in every first batch.
   *
   * *Reproduction:* letting the exception out of `drain` instead of catching it
   * → **stayed green, and that is the finding**: a storage refusal is a result
   * the deletion *reports* (`'files-stuck'`), not one it throws — `removeAll`
   * catches it one level down. This case therefore measures the **reported**
   * branch, and the thrown one has a case of its own below. That the two are
   * different sets is exactly the same review finding, from the other side.
   */
  it('ein scheiterndes Element beendet den Lauf nicht', async () => {
    const broken = await publishedForm(admin, 'Mit Anlage');
    const { fileId } = await submit(broken.slug, broken.id, true);
    expect(fileId).toBeDefined();
    const healthy = await publishedForm(admin, 'Ohne Anlage');

    clock.set(DELETED_AT);
    await trashForm(admin, broken.id);
    clock.set(new Date(DELETED_AT.getTime() + 60_000));
    await trashForm(admin, healthy.id);
    clock.set(daysAfterDeletion(OVER));

    storage.failNextRemoval();
    const run = await purge().runOnce();

    // The broken one stayed, whole: the bytes are the irreversible half, so the
    // row is still there and so is the file row.
    expect(run.failed).toBe(1);
    expect(await formCount(broken.id)).toBe(1);
    // …and the healthy one went in the same run.
    expect(run.forms).toBe(1);
    expect(await formCount(healthy.id)).toBe(0);
    // Counted, not inferred: what is left is exactly the item that failed.
    expect(run.remaining).toBe(1);

    // The next run picks it up — the failure was the volume, not the row.
    const second = await purge().runOnce();
    expect(second.forms).toBe(1);
    expect(second.failed).toBe(0);
    expect(await formCount(broken.id)).toBe(0);
    expect(storage.read(fileId ?? '')).toBeUndefined();
  }, 240_000);

  /**
   * The other half: an item whose deletion **throws**.
   *
   * Only the storage's refusal used to be handled in „Papierkorb leeren", and
   * a review finding named what that left open — a `P2028` on a form
   * with thousands of answers, a lock timeout, a lost connection. Those are
   * decisions PostgreSQL takes, not decisions the deletion takes, and the case
   * above cannot reach them: the storage double's refusal never leaves
   * `removeAll`.
   *
   * There is no way to make PostgreSQL fail on demand without breaking the
   * schema out from under every other query in the same request, so the seam is
   * moved instead — the same shape the `publicUrl` override of
   * `create-test-app.ts` takes, and for the same reason.
   *
   * *Reproduction:* rethrowing in `drain` instead of tallying → **red**, with
   * the second form still standing and the run ending in the rejection.
   */
  it('ein Datenbankfehler an einem Element beendet den Lauf nicht', async () => {
    const first = await publishedForm(admin, 'Wirft');
    const second = await publishedForm(admin, 'Wirft nicht');

    clock.set(DELETED_AT);
    await trashForm(admin, first.id);
    clock.set(new Date(DELETED_AT.getTime() + 60_000));
    await trashForm(admin, second.id);
    clock.set(daysAfterDeletion(OVER));

    const permanent = testApp.app.get(PermanentDeletionService);
    const spy = vi.spyOn(permanent, 'deleteForm').mockRejectedValueOnce(
      // The real thing rather than a bare `Error`: the run's log line reports
      // `error.constructor.name`, and a stand-in would prove the wrong name.
      new Prisma.PrismaClientKnownRequestError(
        'Transaction not found. Transaction ID is invalid.',
        { code: 'P2028', clientVersion: 'test' },
      ),
    );

    let run: Awaited<ReturnType<RetentionPurgeService['runOnce']>>;
    try {
      run = await purge().runOnce();
    } finally {
      spy.mockRestore();
    }

    // The thrown one is counted as failed and stays …
    expect(run.failed).toBe(1);
    expect(await formCount(first.id)).toBe(1);
    // … and the run went on to the next item rather than ending.
    expect(run.forms).toBe(1);
    expect(await formCount(second.id)).toBe(0);

    // The next run finds it again — nothing about the row changed.
    expect((await purge().runOnce()).forms).toBe(1);
    expect(await formCount(first.id)).toBe(0);
  }, 240_000);

  /**
   * **A run ends even when a whole page fails permanently**
   * (a review finding).
   *
   * This is the case the shipped suite did not have, and the gap was not
   * academic: the exclusion list `drain` used to carry was the only thing
   * standing between the run and an endless loop, and **every** case in this
   * file has a handful of items — so removing that line left them all green.
   * Measured while writing this: with the list removed and 150 permanently
   * failing forms, `runOnce()` does not return at all.
   *
   * The reasoning that used to stand in the code and in the worklog („more than
   * 100 due items, *one of them failing*, and the run spins over the same
   * page") was measurably wrong: with exactly one failing item
   * the run does finish — after 151 attempts over 150 items, counting `failed`
   * twice. The danger is **a whole page** of them, which is what this builds.
   *
   * `TRASH_PURGE_BATCH_SIZE + 1` due forms and a spy that refuses every one of
   * them: one full page that makes no progress at all, plus the item behind it.
   * The assertion is deliberately thin — **that `runOnce()` resolves**. What is
   * being measured is termination, so a wrong answer would be no answer.
   *
   * The rows are written straight into the table rather than through the
   * routes, and that is the one place in this file where that is right: 101
   * forms through create/save/publish is 300 requests for a property that is
   * about *how many rows the listing returns*, not about how they got there.
   *
   * *Reproduction:* taking the cursor out of `drain` (listing without `after`)
   * → **red**, and red as a timeout: the run pages over the same 100 forms for
   * ever. Measured on 2026-08-03.
   */
  it('review-fund 3 — eine ganze scheiternde Seite lässt den Lauf trotzdem enden', async () => {
    const count = TRASH_PURGE_BATCH_SIZE + 1;
    const rows = Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      tenantId: home.id,
      title: `Stapel ${String(index)}`,
      // The definition is never read: the deletion is refused before it looks.
      draftSchema: { pages: [] },
      publicSlug: `purge-batch-${randomUUID()}`,
      // Distinct instants, so `(deleted_at, id)` orders them the way a real
      // trash does and the page boundary is not an accident of ties.
      deletedAt: new Date(DELETED_AT.getTime() + index * 1000),
    }));
    await app().prisma.form.createMany({ data: rows });
    clock.set(daysAfterDeletion(OVER));

    const permanent = testApp.app.get(PermanentDeletionService);
    const spy = vi
      .spyOn(permanent, 'deleteForm')
      .mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError(
          'Transaction not found. Transaction ID is invalid.',
          { code: 'P2028', clientVersion: 'test' },
        ),
      );

    try {
      const run = await purge().runOnce();
      // It returned — that is the whole claim. The numbers below only say that
      // it returned having *tried*, rather than by finding nothing.
      expect(run.forms).toBe(0);
      expect(run.failed).toBe(count);
      // Every item once, not once per page: the cursor moves past a failure
      // instead of listing it again, so nothing is counted twice either.
      expect(spy).toHaveBeenCalledTimes(count);
    } finally {
      spy.mockRestore();
    }

    await app().prisma.form.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
  }, 60_000);
  // ═══════════════════════════════════════════════════════════════════════════
  // the evidence — the start-up run
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * **The test application arms nothing**, and every other suite in this
   * repository silently depends on it: an armed retention purge deletes the
   * deleted forms, answers and organisations they are in the middle of counting — and
   * the accounts they are logged in as.
   */
  it('die Testanwendung armiert den Purge nicht', () => {
    expect(purge().schedulerRunning).toBe(false);
  });

  /**
   * **An installation redeployed daily deletes all the same** .
   *
   * The row is put into the trash by the application above, whose interval
   * is `0` — it arms nothing and runs nothing, which is what makes the second
   * application's result attributable to *its own start-up*. That second one
   * comes up with an interval it could not possibly reach inside this test
   * (an hour), and nothing here calls `runOnce()` or fast-forwards a timer.
   *
   * *Reproduction:* dropping the `void this.tick()` from `onModuleInit` → **red**
   * (the form is still there when the budget runs out), while every case above
   * stays green — which is what makes them a control rather than a duplicate.
   * **This is the fault that was built and measured.**
   */
  it('der Nachweis — der Purge läuft beim Start, nicht erst ein Intervall später', async () => {
    const form = await publishedForm(admin, 'Beim Start');
    clock.set(DELETED_AT);
    await trashForm(admin, form.id);
    clock.set(daysAfterDeletion(OVER));

    // The seeding application deletes nothing of its own accord.
    expect(await formCount(form.id)).toBe(1);

    const restarted = await createTestApp({
      databaseUrl: database?.url ?? '',
      env: { TRASH_PURGE_INTERVAL_MS: HUGE_INTERVAL_MS },
      storage,
      clock,
    });
    try {
      expect(restarted.app.get(RetentionPurgeService).schedulerRunning).toBe(
        true,
      );
      expect(
        await waitUntil(async () => (await formCount(form.id)) === 0),
      ).toBe(true);
    } finally {
      await restarted.close();
    }
  }, 240_000);
});
