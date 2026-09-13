import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESPONSE_BULK_DELETE_MAX } from '@formsache/shared';

import { FORM_NOT_FOUND_MESSAGE } from '../../src/common/form-not-found';
import { MISSING_PERMISSION_MESSAGE } from '../../src/tenancy/group-permission.guard';
import { RESPONSE_NOT_FOUND_MESSAGE } from '../../src/trash/trash.service';
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
import { authedMutation, cookieHeader, openSession } from '../support/http';

/**
 * **Several answers into the trash, in one call** (the evidence) — `POST /api/forms/:id/responses/delete`.
 *
 * The action bar of the responses table is a *view* concern; what is
 * measured here is the promise underneath it, and it is the one a table cannot
 * keep: **the route decides per answer, not once per call.** The guard chain
 * runs over the form in the path and says „diese Person darf Antworten dieses
 * Formulars löschen"; it has nothing to say about a single id in the body. So
 * every case below puts an id the caller may **not** touch in the **middle** of
 * a list of ids they may, and asserts two things at once: the call is refused,
 * and **nothing** was written — not even the permitted ids in front of the bad
 * one.
 *
 * ## All or nothing, and why
 *
 * „Teilweise gelöscht, 404 gemeldet" is the worst of the three possible
 * answers: the caller reads a refusal while the table changes underneath them,
 * and pressing again — the one obvious recovery — then deletes nothing at all,
 * because the ids that did go through are no longer live. All-or-nothing is
 * repeatable and says the same thing before and after. It is bought with one
 * transaction in `ScopedFormDelegate.softDeleteResponses`, and the rollback is
 * what the „unverändert" assertions below actually measure.
 *
 * ## The rights are the pair, not the weaker half
 *
 * The specification: everything that touches an answer needs `can_view_responses`
 * **and** `can_build`. Two members hold four of the five permissions each and
 * differ in the one under test, so a 403 cannot be „diese Person hat ohnehin
 * nichts" — the same construction `trash.spec.ts` uses for the single-answer
 * route, and deliberately not a duplicate of its cases: what is new here is
 * that the *bulk* route did not quietly get the weaker bar.
 *
 * *Reproductions, run on 2026-08-06, corrected on 2026-08-08:* dropping
 * `tenantId`/`formId` from the `where` of `softDeleteResponses` turns **two**
 * of the three „mitten in der Liste" cases red — the foreign Organisation and the other
 * form of the same organisation. The third (unknown id, already trashed, malformed id)
 * stays green and needs no binding at all: those ids are refused by
 * `deletedAt: null` and by `isUuid` in `TrashService`, and would be refused by
 * a `where` that named nothing but the ids. Letting the method commit what
 * matched instead of rolling back turns the „unverändert" halves of all three
 * red; weakening the route to `@RequirePermission('canBuild')` turns the
 * rights case red.
 *
 * **The `tenantId` alone is not measured by this suite** — what it does
 * measure and why that stays so stands at the case „`tenant_id` und `form_id`
 * gehören zusammen" further down.
 */

const PASSWORD = 'test-password';
const PAGE = '019ffa00-0000-7000-8000-0000000000a0';
const NAME = '019ffa00-0000-7000-8000-000000000001';
/** A well-formed id that never belonged to anything. */
const UNKNOWN_ID = '019ffa00-0000-7000-8000-0000000000ff';

function definition() {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Seite 1',
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
        ],
      },
    ],
  };
}

describe('mehrere Antworten löschen ', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let admin: string;
  let betaAdmin: string;
  /** Everything except `can_view_responses`. */
  let builder: string;
  /** Everything except `can_build`. */
  let viewer: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'BULK');
    beta = await createTenant(testApp.prisma, 'BULKOTHER');

    const adminUser = await createUser(testApp.prisma, {
      email: 'bulk-admin@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    admin = await openSession(testApp, adminUser.id, alpha.id);

    const betaUser = await createUser(testApp.prisma, {
      email: 'bulk-beta@example.org',
      password: PASSWORD,
      tenants: [beta],
    });
    betaAdmin = await openSession(testApp, betaUser.id, beta.id);

    const builderUser = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'bulk-builder@example.org',
      groupName: 'bearbeiter-bulk',
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
      email: 'bulk-viewer@example.org',
      groupName: 'leser-bulk',
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
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** A published form of the given Organisation, built through the real routes. */
  async function publishedForm(
    token: string,
    title: string,
  ): Promise<{ id: string; slug: string }> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(token))
      .send({ title });
    expect(created.status).toBe(201);
    const form = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };

    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(token))
      .send({ title, definition: definition(), revision: form.revision });
    expect(saved.status).toBe(200);

    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(token))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    return { id: form.id, slug: form.publicSlug };
  }

  /** One submission through the public route; returns its id. */
  async function submit(slug: string, name: string): Promise<string> {
    const sent = await request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .send({ answers: { [NAME]: name } });
    expect(sent.status).toBe(200);

    const row = await app().prisma.response.findFirstOrThrow({
      where: { form: { publicSlug: slug } },
      orderBy: { submittedAt: 'desc' },
      select: { id: true },
    });
    return row.id;
  }

  function bulkDelete(
    token: string,
    formId: string,
    responseIds: readonly string[],
  ): request.Test {
    return request(app().server)
      .post(apiPath(`/forms/${formId}/responses/delete`))
      .set(authedMutation(token))
      .send({ responseIds });
  }

  /** `deleted_at` of every named answer, in the order the ids were given. */
  async function deletionMarks(
    ids: readonly string[],
  ): Promise<(Date | null)[]> {
    const rows = await Promise.all(
      ids.map((id) =>
        app().prisma.response.findUniqueOrThrow({
          where: { id },
          select: { deletedAt: true },
        }),
      ),
    );
    return rows.map((row) => row.deletedAt);
  }

  async function liveResponseIds(
    token: string,
    formId: string,
  ): Promise<string[]> {
    const rows = await request(app().server)
      .get(apiPath(`/forms/${formId}/responses`))
      .set('Cookie', cookieHeader(token));
    expect(rows.status).toBe(200);
    return (rows.body as { id: string }[]).map((row) => row.id);
  }

  async function trashedResponseIds(token: string): Promise<string[]> {
    const view = await request(app().server)
      .get(apiPath('/trash'))
      .set('Cookie', cookieHeader(token));
    expect(view.status).toBe(200);
    return (view.body as { responses: { id: string }[] }).responses.map(
      (row) => row.id,
    );
  }

  /* ---- the evidence: they land in the trash, and come back --------------- */

  it('moves the named answers into the Papierkorb and leaves the rest alone', async () => {
    const form = await publishedForm(admin, 'Sammellöschung');
    const first = await submit(form.slug, 'Erste');
    const second = await submit(form.slug, 'Zweite');
    const third = await submit(form.slug, 'Dritte');

    const deleted = await bulkDelete(admin, form.id, [first, third]);
    expect(deleted.status).toBe(204);

    // Gone from the table…
    expect(await liveResponseIds(admin, form.id)).toStrictEqual([second]);
    // …and *in the trash*, not past it. This is the assertion a
    // review found missing on the single route: „weg aus der Tabelle" is also
    // true of an answer that was destroyed.
    const trashed = await trashedResponseIds(admin);
    expect(trashed).toContain(first);
    expect(trashed).toContain(third);

    // Restorable, one by one, through the route that already existed.
    const back = await request(app().server)
      .post(apiPath(`/forms/${form.id}/responses/${first}/restore`))
      .set(authedMutation(admin));
    expect(back.status).toBe(204);
    expect(new Set(await liveResponseIds(admin, form.id))).toStrictEqual(
      new Set([first, second]),
    );
  }, 60_000);

  it('deletes an answer named twice exactly once', async () => {
    const form = await publishedForm(admin, 'Doppelt genannt');
    const only = await submit(form.slug, 'Einzige');

    const deleted = await bulkDelete(admin, form.id, [only, only]);
    // A duplicate is a request that names nothing wrong — 404 here would be a
    // refusal produced by the counting rule rather than by the data.
    expect(deleted.status).toBe(204);
    expect(await liveResponseIds(admin, form.id)).toStrictEqual([]);
  }, 60_000);

  /* ---- the evidence: per answer, not once per call ----------------------- */

  it('refuses the whole call when an answer of another organisation sits in the middle, and deletes nothing', async () => {
    const form = await publishedForm(admin, 'Fremde Id mittendrin');
    const first = await submit(form.slug, 'Erste');
    const second = await submit(form.slug, 'Zweite');

    const foreignForm = await publishedForm(betaAdmin, 'Anderer Organisation');
    const foreign = await submit(foreignForm.slug, 'Fremde');

    const refused = await bulkDelete(admin, form.id, [first, foreign, second]);
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({
      message: RESPONSE_NOT_FOUND_MESSAGE,
    });

    // **Nothing** — including the two the caller was entitled to delete and
    // that stand *before* the foreign id in the list.
    expect(await deletionMarks([first, second, foreign])).toStrictEqual([
      null,
      null,
      null,
    ]);
    expect(new Set(await liveResponseIds(admin, form.id))).toStrictEqual(
      new Set([first, second]),
    );
  }, 60_000);

  it('refuses an answer of another form of the same organisation, and deletes nothing', async () => {
    const form = await publishedForm(admin, 'Erstes Formular');
    const first = await submit(form.slug, 'Erste');
    const second = await submit(form.slug, 'Zweite');

    const other = await publishedForm(admin, 'Zweites Formular');
    const elsewhere = await submit(other.slug, 'Woanders');

    const refused = await bulkDelete(admin, form.id, [
      first,
      elsewhere,
      second,
    ]);
    expect(refused.status).toBe(404);
    expect(await deletionMarks([first, second, elsewhere])).toStrictEqual([
      null,
      null,
      null,
    ]);
  }, 60_000);

  it('refuses an unknown id and an already deleted one, and deletes nothing', async () => {
    const form = await publishedForm(admin, 'Unbekannte Id');
    const first = await submit(form.slug, 'Erste');
    const second = await submit(form.slug, 'Zweite');
    const gone = await submit(form.slug, 'Schon weg');

    await request(app().server)
      .delete(apiPath(`/forms/${form.id}/responses/${gone}`))
      .set(authedMutation(admin));

    for (const stranger of [UNKNOWN_ID, gone, 'keine-uuid']) {
      const refused = await bulkDelete(admin, form.id, [
        first,
        stranger,
        second,
      ]);
      expect(refused.status).toBe(404);
      // The one door: „gibt es nicht", „liegt schon im Papierkorb" and „ist
      // keine Id" are indistinguishable from the outside.
      expect(refused.body).toMatchObject({
        message: RESPONSE_NOT_FOUND_MESSAGE,
      });
      expect(await deletionMarks([first, second])).toStrictEqual([null, null]);
    }
  }, 60_000);

  /**
   * **Why the `tenantId` in `softDeleteResponses` is defence in depth — and
   * what of it is measurable at all** (a review finding).
   *
   * Removing `tenantId: this.tenantId` from that `where` leaves every case
   * above green, and the honest reason is not a thin fixture: **the state that
   * line guards against cannot exist.** `response(form_id, tenant_id)` is a
   * composite foreign key onto `form(id, tenant_id)`
   * (`response_form_id_tenant_id_fkey`), so an answer cannot name this form and
   * a foreign Organisation at the same time — which is precisely what a fixture for
   * „fremde `tenant_id`, eigene `form_id`" would have to write.
   *
   * So this case measures the constraint instead of a refusal no request can
   * provoke. That is not a consolation prize: the constraint is *why* the
   * `formId` in the `where` suffices today, and dropping it — a schema change,
   * not a refactoring of the service — is what would turn the missing
   * `tenantId` into a real hole. The route's refusal of an answer belonging to
   * another organisation stays measured by the „an answer of another
   * organisation sits in the middle" case above,
   * where the foreign id comes with its own foreign form.
   */
  it('cannot be handed an answer whose Organisation and form disagree — the schema forbids the row', async () => {
    const form = await publishedForm(
      admin,
      'Organisation und Formular gehören zusammen',
    );
    const answer = await submit(form.slug, 'Jemand');

    // The write a fixture for the missing case would need. `P2003` is Prisma's
    // foreign-key violation — PostgreSQL refuses it, not the application.
    await expect(
      app().prisma.response.update({
        where: { id: answer },
        data: { tenantId: beta.id },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });

    const row = await app().prisma.response.findUniqueOrThrow({
      where: { id: answer },
      select: { tenantId: true },
    });
    expect(row.tenantId).toBe(alpha.id);
  }, 60_000);

  it('answers 404 for a form of another organisation without looking at the ids', async () => {
    const form = await publishedForm(
      admin,
      'Formular einer anderen Organisation',
    );
    const answer = await submit(form.slug, 'Jemand');

    const refused = await bulkDelete(betaAdmin, form.id, [answer]);
    expect(refused.status).toBe(404);
    // About the **form**, so nothing is confirmed about an answer whose
    // existence the message would otherwise give away.
    expect(refused.body).toMatchObject({ message: FORM_NOT_FOUND_MESSAGE });
    expect(await deletionMarks([answer])).toStrictEqual([null]);
  }, 60_000);

  /* ---- the rights: the pair, not the weaker half  ---------- */

  it('refuses the bulk delete to anyone holding only one half of the pair', async () => {
    const form = await publishedForm(admin, 'Rechte der Sammellöschung');
    const first = await submit(form.slug, 'Erste');
    const second = await submit(form.slug, 'Zweite');

    for (const token of [builder, viewer]) {
      const refused = await bulkDelete(token, form.id, [first, second]);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        message: MISSING_PERMISSION_MESSAGE,
      });
    }

    expect(await deletionMarks([first, second])).toStrictEqual([null, null]);
  }, 60_000);

  /* ---- the payload limit  -------------------------------- */

  it('refuses an empty list rather than reading it as „alle"', async () => {
    const form = await publishedForm(admin, 'Leere Liste');
    const only = await submit(form.slug, 'Einzige');

    const refused = await bulkDelete(admin, form.id, []);
    expect(refused.status).toBe(400);
    expect(await deletionMarks([only])).toStrictEqual([null]);
  }, 60_000);

  it('refuses more ids than the payload limit allows', async () => {
    const form = await publishedForm(admin, 'Zu viele Ids');
    const only = await submit(form.slug, 'Einzige');

    const tooMany = [
      only,
      ...Array.from(
        { length: RESPONSE_BULK_DELETE_MAX },
        (_, index) =>
          // Well-formed ids, so the refusal is the *limit* and not the shape.
          `019ffa00-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
      ),
    ];

    const refused = await bulkDelete(admin, form.id, tooMany);
    expect(refused.status).toBe(400);
    expect(await deletionMarks([only])).toStrictEqual([null]);
  }, 60_000);
});
