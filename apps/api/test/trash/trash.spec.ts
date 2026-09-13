import { randomBytes } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FORM_NOT_FOUND_MESSAGE } from '../../src/common/form-not-found';
import { FormRestriction } from '../../src/tenancy/form-restriction';
import { MISSING_PERMISSION_MESSAGE } from '../../src/tenancy/group-permission.guard';
import { TenantScope } from '../../src/tenancy/tenant-scope';
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
 * **The trash: delete, restore, and who may do that** (the requirement's server side).
 *
 * `form.deleted_at` and `response.deleted_at` have existed and every
 * read has filtered them since then; this suite is about the routes that
 * finally *write* them. It is written the way `CONTRIBUTING.md` demands of a
 * rights rule: **every guarantee is asserted through the case that must
 * fail.**
 *
 * ## The measurement that matters most is the public one
 *
 * „A deleted form that keeps answering publicly is the fault
 * that nobody sees." The assertion for it is not „answers 404" — it is
 * **byte-identical to an address that never existed**, status, body and all
 * (`answers exactly like an address that was never minted`). A 410, a „this
 * form was deleted" or a different header set would each be an oracle
 * telling a stranger that this address once led somewhere.
 *
 * *Reproduction, measured on 2026-08-03:* removing the `form?.deletedAt != null`
 * condition from `PublicFormsService.load()` turns **exactly that one case**
 * red — the deleted form answers 200 where 404 is asserted — and leaves the
 * other twelve in this file green, which is precisely why it is asserted
 * separately from „is gone from the list": the admin surface notices nothing.
 *
 * ## The permission pairs
 *
 * Two members carry **four of the five** permissions each and differ in the one
 * under test, so a refusal cannot be „this person happens to hold nothing":
 *
 * - `builder` — everything except `can_view_responses`;
 * - `viewer` — everything except `can_build`.
 *
 * *Reproduction, measured on 2026-08-03, in **both** directions:* weakening
 * `@RequireAllPermissions('canViewResponses', 'canBuild')` on the two answer
 * routes to `@RequirePermission('canViewResponses')` turns the two „only one
 * half of the pair" cases red (204 where 403 is asserted); weakening it to
 * `@RequirePermission('canBuild')` instead turns the **same two** red the same
 * way. Both halves of the pair are load-bearing, and neither reproduction
 * touched the other four cases of this block.
 */

const PASSWORD = 'test-password';
const PAGE = '019ff600-0000-7000-8000-0000000000a0';
const NAME = '019ff600-0000-7000-8000-000000000001';

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

/**
 * An address of the right *shape* that no form ever carried — the control the
 * public 404 is compared against.
 *
 * Minted the same way `FormsService` mints a real one (16 random bytes,
 * base64url), because a malformed string is refused one step earlier
 * (`isPublicSlug`) and would prove nothing about the lookup.
 */
function inventedSlug(): string {
  return randomBytes(16).toString('base64url');
}

describe('der Papierkorb — Serverseite', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let admin: string;
  let betaAdmin: string;
  let builder: string;
  let viewer: string;
  /** All five permissions and **restrictable** — the fourth link's subject. */
  let manager: string;
  let managerId: string;
  /** Cap groups: one below `can_build`, one below `can_view_responses`. */
  let noBuildGroupId: string;
  let noAnswersGroupId: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'TRASH');
    beta = await createTenant(testApp.prisma, 'OTHER');

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

    // Holds **everything** and is still restrictable: a refusal on one of this
    // person's forms can only come from the fourth link of the chain.
    const managerUser = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'manager@example.org',
      groupName: 'verwalter',
      permissions: {
        canBuild: true,
        canViewResponses: true,
        canExport: true,
        canManageSettings: true,
        canManageFormSettings: true,
        canManageUsers: true,
      },
    });
    managerId = managerUser.id;
    manager = await openSession(testApp, managerUser.id, alpha.id);

    noBuildGroupId = await capGroup('gedeckelt-ohne-bauen', {
      canBuild: false,
      canViewResponses: true,
    });
    noAnswersGroupId = await capGroup('gedeckelt-ohne-antworten', {
      canBuild: true,
      canViewResponses: false,
    });
  }, 180_000);

  /** A group a `form_permission` row can cap **to** — never a system group. */
  async function capGroup(
    name: string,
    permissions: { canBuild: boolean; canViewResponses: boolean },
  ): Promise<string> {
    const group = await testApp.prisma.group.create({
      data: {
        tenantId: alpha.id,
        name,
        color: '#5b6b52',
        rank: 10,
        isSystem: false,
        canBuild: permissions.canBuild,
        canViewResponses: permissions.canViewResponses,
        canExport: true,
        canManageSettings: true,
        canManageFormSettings: true,
        canManageUsers: true,
      },
      select: { id: true },
    });
    return group.id;
  }

  /**
   * A `form_permission` row **straight into PostgreSQL**.
   *
   * The rows are the *input* to the rule under test, not the rule; writing them
   * through `PUT /forms/:id/members/:userId` would drag that route's own
   * refusals (rank, self-lockout) into cases that are about the trash.
   */
  async function restrict(
    formId: string,
    options: {
      readonly accessRevoked?: boolean;
      readonly cappedGroupId?: string | null;
    },
  ): Promise<void> {
    await app().prisma.formPermission.create({
      data: {
        tenantId: alpha.id,
        formId,
        userId: managerId,
        accessRevoked: options.accessRevoked ?? false,
        cappedGroupId: options.cappedGroupId ?? null,
      },
    });
  }

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** A published form of ALPHA, built through the real routes. */
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
      .send({ title, definition: definition(), revision: form.revision });
    expect(saved.status).toBe(200);

    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(admin))
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

  async function formIds(token: string): Promise<string[]> {
    const list = await request(app().server)
      .get(apiPath('/forms'))
      .set('Cookie', cookieHeader(token));
    expect(list.status).toBe(200);
    // `items`: `GET /forms` answers a page, not a bare array.
    return (list.body as { items: { id: string }[] }).items.map(
      (form) => form.id,
    );
  }

  async function trash(token: string): Promise<{
    forms: { id: string; title: string; responseCount: number }[];
    responses: { id: string; formId: string; formTitle: string }[];
  }> {
    const view = await request(app().server)
      .get(apiPath('/trash'))
      .set('Cookie', cookieHeader(token));
    expect(view.status).toBe(200);
    return view.body as Awaited<ReturnType<typeof trash>>;
  }

  /* ---- a form goes in and comes back ------------------------------- */

  it('takes a form out of the list and puts it in the Papierkorb', async () => {
    const form = await publishedForm('Bestandsmeldung');
    expect(await formIds(admin)).toContain(form.id);

    const deleted = await request(app().server)
      .delete(apiPath(`/forms/${form.id}`))
      .set(authedMutation(admin));
    expect(deleted.status).toBe(204);

    expect(await formIds(admin)).not.toContain(form.id);
    // …and every other form route answers like an unknown id, which is what
    // „gone from the navigation" means on the server side.
    const read = await request(app().server)
      .get(apiPath(`/forms/${form.id}`))
      .set('Cookie', cookieHeader(admin));
    expect(read.status).toBe(404);
    expect(read.body).toMatchObject({ message: FORM_NOT_FOUND_MESSAGE });

    const listed = await trash(admin);
    expect(listed.forms.map((one) => one.id)).toContain(form.id);
  }, 60_000);

  /**
   * **The case nobody sees** — the requirement's first piece of evidence, and the one whose
   * reproduction the header names.
   */
  it('answers the public address exactly like an address that was never minted', async () => {
    const form = await publishedForm('Öffentlich');

    const before = await request(app().server).get(
      apiPath(`/public/forms/${form.slug}`),
    );
    expect(before.status).toBe(200);

    expect(
      (
        await request(app().server)
          .delete(apiPath(`/forms/${form.id}`))
          .set(authedMutation(admin))
      ).status,
    ).toBe(204);

    const deleted = await request(app().server).get(
      apiPath(`/public/forms/${form.slug}`),
    );
    const nowhere = await request(app().server).get(
      apiPath(`/public/forms/${inventedSlug()}`),
    );

    expect(deleted.status).toBe(404);
    expect(deleted.status).toBe(nowhere.status);
    // Byte for byte: the sentence, the status field, everything. A body that
    // said „deleted" would be the oracle this assertion exists against.
    expect(deleted.body).toStrictEqual(nowhere.body);
    expect(deleted.text).toBe(nowhere.text);
  }, 60_000);

  it('gives the form back, with its public address, when it is restored', async () => {
    const form = await publishedForm('Zurück');
    await request(app().server)
      .delete(apiPath(`/forms/${form.id}`))
      .set(authedMutation(admin));

    const restored = await request(app().server)
      .post(apiPath(`/forms/${form.id}/restore`))
      .set(authedMutation(admin));
    expect(restored.status).toBe(204);

    expect(await formIds(admin)).toContain(form.id);
    expect(
      (await request(app().server).get(apiPath(`/public/forms/${form.slug}`)))
        .status,
    ).toBe(200);
    expect((await trash(admin)).forms.map((one) => one.id)).not.toContain(
      form.id,
    );
  }, 60_000);

  /* ---- an answer goes in and comes back ---------------------------- */

  it('takes an answer out of the responses table and puts it in the Papierkorb', async () => {
    const form = await publishedForm('Anmeldung');
    const first = await submit(form.slug, 'Erste');
    const second = await submit(form.slug, 'Zweite');

    const deleted = await request(app().server)
      .delete(apiPath(`/forms/${form.id}/responses/${first}`))
      .set(authedMutation(admin));
    expect(deleted.status).toBe(204);

    const rows = await request(app().server)
      .get(apiPath(`/forms/${form.id}/responses`))
      .set('Cookie', cookieHeader(admin));
    expect((rows.body as { id: string }[]).map((one) => one.id)).toStrictEqual([
      second,
    ]);

    const listed = await trash(admin);
    expect(listed.responses.map((one) => one.id)).toContain(first);
    // The row names its form, because the section is tenant-wide.
    expect(listed.responses.find((one) => one.id === first)?.formTitle).toBe(
      'Anmeldung',
    );

    const restored = await request(app().server)
      .post(apiPath(`/forms/${form.id}/responses/${first}/restore`))
      .set(authedMutation(admin));
    expect(restored.status).toBe(204);

    const after = await request(app().server)
      .get(apiPath(`/forms/${form.id}/responses`))
      .set('Cookie', cookieHeader(admin));
    expect(
      new Set((after.body as { id: string }[]).map((one) => one.id)),
    ).toStrictEqual(new Set([first, second]));
  }, 60_000);

  /**
   * A deleted form's answers do **not** turn up in the answers section as well.
   *
   * Otherwise the trash would offer „wiederherstellen" on an answer whose
   * form is one section above — putting it back into a form nobody can open.
   */
  it('keeps the answers of a deleted form out of the answer section', async () => {
    const form = await publishedForm('Mit Antwort gelöscht');
    const answer = await submit(form.slug, 'Jemand');

    await request(app().server)
      .delete(apiPath(`/forms/${form.id}/responses/${answer}`))
      .set(authedMutation(admin));
    expect((await trash(admin)).responses.map((one) => one.id)).toContain(
      answer,
    );

    await request(app().server)
      .delete(apiPath(`/forms/${form.id}`))
      .set(authedMutation(admin));

    const listed = await trash(admin);
    expect(listed.responses.map((one) => one.id)).not.toContain(answer);
    expect(listed.forms.map((one) => one.id)).toContain(form.id);
    // The deleted answer is not counted on the form's row either — the two
    // sections would otherwise add up to more than the trash holds.
    expect(listed.forms.find((one) => one.id === form.id)?.responseCount).toBe(
      0,
    );

    // …and it comes back into reach with its form.
    await request(app().server)
      .post(apiPath(`/forms/${form.id}/restore`))
      .set(authedMutation(admin));
    expect((await trash(admin)).responses.map((one) => one.id)).toContain(
      answer,
    );
  }, 60_000);

  /* ---- the evidence: the trash is an organisation's own ------------------------ */

  it('answers 404 for another organisation on every Papierkorb route', async () => {
    const form = await publishedForm('Fremd');
    const answer = await submit(form.slug, 'Jemand');

    const foreign = [
      request(app().server)
        .delete(apiPath(`/forms/${form.id}`))
        .set(authedMutation(betaAdmin)),
      request(app().server)
        .post(apiPath(`/forms/${form.id}/restore`))
        .set(authedMutation(betaAdmin)),
      request(app().server)
        .delete(apiPath(`/forms/${form.id}/responses/${answer}`))
        .set(authedMutation(betaAdmin)),
      request(app().server)
        .post(apiPath(`/forms/${form.id}/responses/${answer}/restore`))
        .set(authedMutation(betaAdmin)),
    ];

    for (const attempt of await Promise.all(foreign)) {
      expect(attempt.status).toBe(404);
      expect(attempt.body).toMatchObject({ message: FORM_NOT_FOUND_MESSAGE });
    }

    // The row is untouched — a refused delete must not be a delete.
    const row = await app().prisma.form.findUniqueOrThrow({
      where: { id: form.id },
      select: { deletedAt: true },
    });
    expect(row.deletedAt).toBeNull();

    // …and BETA's own trash never mentions ALPHA's form.
    await request(app().server)
      .delete(apiPath(`/forms/${form.id}`))
      .set(authedMutation(admin));
    expect((await trash(betaAdmin)).forms.map((one) => one.id)).not.toContain(
      form.id,
    );
  }, 60_000);

  it('answers 404 for an answer that is not in the Papierkorb, and for one that never was', async () => {
    const form = await publishedForm('Nicht gelöscht');
    const answer = await submit(form.slug, 'Jemand');

    const live = await request(app().server)
      .post(apiPath(`/forms/${form.id}/responses/${answer}/restore`))
      .set(authedMutation(admin));
    expect(live.status).toBe(404);
    expect(live.body).toMatchObject({ message: RESPONSE_NOT_FOUND_MESSAGE });

    const unknown = await request(app().server)
      .delete(
        apiPath(
          `/forms/${form.id}/responses/019ff600-0000-7000-8000-00000000ffff`,
        ),
      )
      .set(authedMutation(admin));
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ message: RESPONSE_NOT_FOUND_MESSAGE });
    // The same door for „does not exist" and „is not in the Papierkorb": two
    // bodies would tell a caller which of the two it is.
    expect(unknown.body).toStrictEqual(live.body);
  }, 60_000);

  /* ---- the rights, proven through the refusals --------------------- */

  describe('die Rechte', () => {
    /**
     * **`can_build` alone deletes a whole form** — including its answers, which
     * this editor may not read one by one.
     *
     * The case is written out rather than merely passing, because it is the
     * apparent contradiction in the requirement and it is a **decided** one
     * (2026-08-03): the same `builder` gets 403 on a single answer below and 204
     * here on the form that holds them all. Deleting a form is reversible — 30
     * days in the trash, restorable by this very person, with every answer
     * still in it — so it is „taking out of service", not „taking away"; reaching
     * into one Anmeldung one may not read is neither reversible nor undoable by
     * anybody else. Where reversibility ends, the pair returns: final
     * deletion and „Papierkorb leeren" additionally demand `can_view_responses`.
     */
    it('lets a Bearbeiter delete and restore a form', async () => {
      const form = await publishedForm('Bearbeiter darf');
      // With an answer in it, so the sentence above is about this test rather
      // than about an empty form nobody has registered for.
      const answer = await submit(form.slug, 'Angemeldet');

      expect(
        (
          await request(app().server)
            .delete(apiPath(`/forms/${form.id}`))
            .set(authedMutation(builder))
        ).status,
      ).toBe(204);
      // …and the answer went with it, unread by the person who deleted it.
      expect(
        (
          await request(app().server)
            .delete(apiPath(`/forms/${form.id}/responses/${answer}`))
            .set(authedMutation(builder))
        ).status,
      ).toBe(403);

      expect(
        (
          await request(app().server)
            .post(apiPath(`/forms/${form.id}/restore`))
            .set(authedMutation(builder))
        ).status,
      ).toBe(204);
      // Reversible in full: the registration is back, untouched.
      expect(
        (
          await app().prisma.response.findUniqueOrThrow({
            where: { id: answer },
            select: { deletedAt: true },
          })
        ).deletedAt,
      ).toBeNull();
    }, 60_000);

    it('refuses a member without can_build both verbs on a form', async () => {
      const form = await publishedForm('Leser darf nicht');

      const remove = await request(app().server)
        .delete(apiPath(`/forms/${form.id}`))
        .set(authedMutation(viewer));
      expect(remove.status).toBe(403);
      expect(remove.body).toMatchObject({
        message: MISSING_PERMISSION_MESSAGE,
      });

      // Deleted by somebody who may, so the restore is refused for the right
      // reason rather than for „nothing in the Papierkorb".
      await request(app().server)
        .delete(apiPath(`/forms/${form.id}`))
        .set(authedMutation(admin));

      const back = await request(app().server)
        .post(apiPath(`/forms/${form.id}/restore`))
        .set(authedMutation(viewer));
      expect(back.status).toBe(403);
      expect(back.body).toMatchObject({ message: MISSING_PERMISSION_MESSAGE });

      // The row is untouched by both.
      expect(
        (
          await app().prisma.form.findUniqueOrThrow({
            where: { id: form.id },
            select: { deletedAt: true },
          })
        ).deletedAt,
      ).not.toBeNull();
    }, 60_000);

    /**
     * **The „decision of its own" of the requirement, from both sides.**
     *
     * Reading an answer is not deciding that it goes away, so
     * `can_view_responses` alone is refused; and deleting an answer one may not
     * look at is refused too, so `can_build` alone is not enough either. Each
     * of the two members holds four of the five permissions.
     */
    it('refuses to delete an answer to anyone holding only one half of the pair', async () => {
      const form = await publishedForm('Antwort löschen');
      const answer = await submit(form.slug, 'Jemand');

      for (const token of [builder, viewer]) {
        const remove = await request(app().server)
          .delete(apiPath(`/forms/${form.id}/responses/${answer}`))
          .set(authedMutation(token));
        expect(remove.status).toBe(403);
        expect(remove.body).toMatchObject({
          message: MISSING_PERMISSION_MESSAGE,
        });
      }

      expect(
        (
          await app().prisma.response.findUniqueOrThrow({
            where: { id: answer },
            select: { deletedAt: true },
          })
        ).deletedAt,
      ).toBeNull();
    }, 60_000);

    it('refuses to restore an answer to anyone holding only one half of the pair', async () => {
      const form = await publishedForm('Antwort zurück');
      const answer = await submit(form.slug, 'Jemand');
      await request(app().server)
        .delete(apiPath(`/forms/${form.id}/responses/${answer}`))
        .set(authedMutation(admin));

      for (const token of [builder, viewer]) {
        const back = await request(app().server)
          .post(apiPath(`/forms/${form.id}/responses/${answer}/restore`))
          .set(authedMutation(token));
        expect(back.status).toBe(403);
        expect(back.body).toMatchObject({
          message: MISSING_PERMISSION_MESSAGE,
        });
      }

      expect(
        (
          await app().prisma.response.findUniqueOrThrow({
            where: { id: answer },
            select: { deletedAt: true },
          })
        ).deletedAt,
      ).not.toBeNull();
    }, 60_000);

    /**
     * The page itself: `can_build` opens it (it is the weaker of the two delete
     * rights), `can_view_responses` alone does not — that member may delete
     * nothing at all.
     */
    it('opens the Papierkorb to a Bearbeiter and refuses it to a pure Leser', async () => {
      expect(
        (
          await request(app().server)
            .get(apiPath('/trash'))
            .set('Cookie', cookieHeader(builder))
        ).status,
      ).toBe(200);

      const refused = await request(app().server)
        .get(apiPath('/trash'))
        .set('Cookie', cookieHeader(viewer));
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        message: MISSING_PERMISSION_MESSAGE,
      });
    }, 60_000);

    /**
     * **The fourth link in the trash** — form restriction, measured on
     * the cases that must fail (a review finding).
     *
     * Until these existed, `apps/api/test/trash/` contained not one
     * `form_permission` row: removing **both** `restriction.formFilter()` calls
     * from `TrashService.view` left all thirteen cases of this file green. The
     * per-form link was written and untested, which is the same thing as
     * untested.
     *
     * The subject is `manager`, who holds **all five** group permissions and is
     * restrictable — so nothing below can be „this person was not allowed
     * anything anyway". The four cases are the four shapes the link has: revoked in each
     * of the two sections, revoked on a write route, and capped in each of the
     * two directions.
     */
    describe('die Formular-Restriktion im Papierkorb', () => {
      /**
       * *Reproduction, measured on 2026-08-03:* dropping `formFilter()` from
       * `ScopedFormDelegate.findManyDeleted`'s call in `TrashService.view` shows
       * the form here and leaves the other case below green.
       */
      it('keeps a form the member is locked out of out of the forms section', async () => {
        const form = await publishedForm('Gesperrt und gelöscht');
        await restrict(form.id, { accessRevoked: true });

        await request(app().server)
          .delete(apiPath(`/forms/${form.id}`))
          .set(authedMutation(admin));

        // The trash holds it — for somebody who may see it.
        expect((await trash(admin)).forms.map((one) => one.id)).toContain(
          form.id,
        );
        expect((await trash(manager)).forms.map((one) => one.id)).not.toContain(
          form.id,
        );
      }, 60_000);

      /**
       * The same fragment one level down: a revoked form's answers are its
       * answers.
       *
       * ⚠️ **Two mechanisms cover this row, and only one of them is a
       * boundary** — measured on 2026-08-03, and worth writing down because it
       * decides what this case can prove. Dropping `formFilter()` from the
       * `deletedResponses` call leaves the payload **unchanged**: the effective
       * permissions of a revoked form are `NO_PERMISSIONS`, so
       * `mayViewAnswersOf` drops the same row one step later, in the service.
       * The fragment is what keeps it from leaving PostgreSQL in the first
       * place (the specification: a boundary, not a display question), and *that* is
       * asserted directly on the delegate below — through the same fragment the
       * service passes, because an HTTP response cannot tell the two apart.
       */
      it('keeps the answers of such a form out of the answers section', async () => {
        const form = await publishedForm('Gesperrt, Antwort gelöscht');
        const answer = await submit(form.slug, 'Jemand');
        await restrict(form.id, { accessRevoked: true });

        await request(app().server)
          .delete(apiPath(`/forms/${form.id}/responses/${answer}`))
          .set(authedMutation(admin));

        expect((await trash(admin)).responses.map((one) => one.id)).toContain(
          answer,
        );
        const listed = await trash(manager);
        expect(listed.responses.map((one) => one.id)).not.toContain(answer);
        // …and not through the form's title either: the whole payload is
        // searched, never only the field a mapper happens to fill.
        expect(JSON.stringify(listed)).not.toContain(
          'Gesperrt, Antwort gelöscht',
        );

        // **The boundary itself**: the statement, with the fragment the guard
        // chain builds for this person, does not return the row at all.
        const scope = new TenantScope(app().prisma, alpha.id);
        const restriction = new FormRestriction(
          managerId,
          true,
          {
            canBuild: true,
            canViewResponses: true,
            canExport: true,
            canManageSettings: true,
            canManageFormSettings: true,
            canManageUsers: true,
          },
          undefined,
        );
        const rows = await scope.forms.deletedResponses(
          restriction.formFilter(),
        );
        expect(rows.map((one) => one.id)).not.toContain(answer);
        // The same statement without it *does* — otherwise this assertion would
        // be green for a query that returns nothing at all.
        expect(
          (await scope.forms.deletedResponses()).map((one) => one.id),
        ).toContain(answer);
      }, 60_000);

      /**
       * **A revocation answers 404, byte-identical to an unknown id** — the
       * same door `FormRestrictionGuard` uses everywhere else, on the write
       * route this milestone added.
       */
      it('answers 404 when somebody locked out of a form deletes it', async () => {
        const form = await publishedForm('Gesperrt, löschen verboten');
        await restrict(form.id, { accessRevoked: true });

        const refused = await request(app().server)
          .delete(apiPath(`/forms/${form.id}`))
          .set(authedMutation(manager));

        expect(refused.status).toBe(404);
        expect(refused.body).toMatchObject({ message: FORM_NOT_FOUND_MESSAGE });
        // The row is untouched — a refused delete must not be a delete.
        expect(
          (
            await app().prisma.form.findUniqueOrThrow({
              where: { id: form.id },
              select: { deletedAt: true },
            })
          ).deletedAt,
        ).toBeNull();
      }, 60_000);

      /**
       * **A cap is 403, not 404** — the form is still there, this person simply
       * may not do *this* on it. Capped to a role without `can_build`, i.e. to
       * exactly what the requirement makes the restore depend on.
       */
      it('refuses the restore to somebody capped below can_build', async () => {
        const form = await publishedForm('Gedeckelt, kein Bauen');
        await restrict(form.id, { cappedGroupId: noBuildGroupId });

        await request(app().server)
          .delete(apiPath(`/forms/${form.id}`))
          .set(authedMutation(admin));

        const refused = await request(app().server)
          .post(apiPath(`/forms/${form.id}/restore`))
          .set(authedMutation(manager));

        expect(refused.status).toBe(403);
        expect(refused.body).toMatchObject({
          message: MISSING_PERMISSION_MESSAGE,
        });
        expect(
          (
            await app().prisma.form.findUniqueOrThrow({
              where: { id: form.id },
              select: { deletedAt: true },
            })
          ).deletedAt,
        ).not.toBeNull();
      }, 60_000);

      /**
       * **A cap does not hide the form — it hides its answers.** The other
       * direction of the same row: capped below `can_view_responses`, the form
       * stays in the section above (403 is not 404) and its deleted answer must
       * not appear in the one below, because that would tell somebody who may
       * not read answers that a registration was made and withdrawn.
       */
      it('keeps the answer out of the section for somebody capped below can_view_responses', async () => {
        const form = await publishedForm('Gedeckelt, keine Antworten');
        const answer = await submit(form.slug, 'Jemand');
        await restrict(form.id, { cappedGroupId: noAnswersGroupId });

        await request(app().server)
          .delete(apiPath(`/forms/${form.id}/responses/${answer}`))
          .set(authedMutation(admin));

        const listed = await trash(manager);
        expect(listed.responses.map((one) => one.id)).not.toContain(answer);
        expect((await trash(admin)).responses.map((one) => one.id)).toContain(
          answer,
        );

        // …and the cap really is only a cap: the form itself stays reachable.
        expect(
          (
            await request(app().server)
              .get(apiPath(`/forms/${form.id}`))
              .set('Cookie', cookieHeader(manager))
          ).status,
        ).toBe(200);
      }, 60_000);
    });

    /**
     * An editor without `can_view_responses` sees the **forms** section and
     * not the answers — „an editor sees in it only what they may see
     * anyway" (the specification).
     */
    it('shows a Bearbeiter without can_view_responses no deleted answers', async () => {
      const form = await publishedForm('Sichtbarkeit');
      const answer = await submit(form.slug, 'Jemand');
      await request(app().server)
        .delete(apiPath(`/forms/${form.id}/responses/${answer}`))
        .set(authedMutation(admin));

      expect((await trash(admin)).responses.map((one) => one.id)).toContain(
        answer,
      );
      expect(
        (await trash(builder)).responses.map((one) => one.id),
      ).not.toContain(answer);
    }, 60_000);
  });
});
