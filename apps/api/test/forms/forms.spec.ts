import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { formatTimestamp } from '@formsache/shared';

import { MISSING_PERMISSION_MESSAGE } from '../../src/tenancy/group-permission.guard';
import {
  FORM_NOT_FOUND_MESSAGE,
  NOTHING_TO_PUBLISH_MESSAGE,
  STALE_REVISION_MESSAGE,
} from '../../src/forms/forms.service';
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
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';

/**
 * The requirements, measured against real PostgreSQL.
 *
 * The suite is written the way `CONTRIBUTING.md` demands of a rights or isolation
 * rule: **every guarantee is asserted through the case that must fail.** A
 * test that only shows ALPHA reading ALPHA's own form would stay green if the
 * tenant binding were dropped tomorrow.
 *
 * **Negative probe, measured while writing this file.** Deleting `tenantId`
 * from the `where` of `findManyWithCounts`/`findById` in `ScopedFormDelegate`
 * turns exactly three tests red — "answers 404 for a form of another organisation",
 * "refuses to overwrite a form of another organisation" and "never lists a form of
 * another organisation" — and BETA receives ALPHA's form. Everything else stays green,
 * which is precisely why a suite of only positive cases proves nothing.
 */

const PASSWORD = 'test-password';

/**
 * A definition with one question field overridden — used for the cases that
 * must be refused.
 *
 * Built rather than mutated: reaching into `pages[0].questions[0]` needs two
 * non-null assertions, and an assertion in a test is a claim the test itself
 * cannot check.
 */
function brokenDefinition(overrides: Record<string, unknown>) {
  const { pages } = definition();
  // Destructured with a default rather than asserted: `definition()` builds
  // both, but a test may not claim what it has not checked.
  const [page = { id: '', title: '', questions: [] }] = pages;
  const [question = {}] = page.questions;
  return {
    pages: [{ ...page, questions: [{ ...question, ...overrides }] }],
  };
}

/** A minimal but real definition — one page, one required text question. */
function definition(label = 'Name') {
  return {
    pages: [
      {
        id: '019fd000-0000-7000-8000-0000000000a0',
        title: 'Seite 1',
        questions: [
          {
            id: '019fd000-0000-7000-8000-000000000001',
            type: 'text',
            label,
            hint: null,
            required: true,
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

describe('forms', () => {
  let testApp: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaAdmin: string;
  let betaAdmin: string;
  let database: TestDatabase | undefined;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'ALPHA');
    beta = await createTenant(testApp.prisma, 'BETA');

    const alphaUser = await createUser(testApp.prisma, {
      email: 'alpha@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    const betaUser = await createUser(testApp.prisma, {
      email: 'beta@example.org',
      password: PASSWORD,
      tenants: [beta],
    });

    alphaAdmin = await openSession(testApp, alphaUser.id, alpha.id);
    betaAdmin = await openSession(testApp, betaUser.id, beta.id);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** Creates a form as the given session and returns the parsed body. */
  async function createForm(
    token: string,
    title = 'Bestandsmeldung',
  ): Promise<{ id: string; revision: number; publicSlug: string }> {
    const response = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(token))
      .send({ title });
    expect(response.status).toBe(201);
    return response.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };
  }

  describe('the tenant boundary', () => {
    it('creates a form and reads it back', async () => {
      const created = await createForm(alphaAdmin);

      const response = await request(app().server)
        .get(apiPath(`/forms/${created.id}`))
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: created.id,
        title: 'Bestandsmeldung',
        status: 'draft',
        publishedVersion: null,
      });
    });

    /**
     * The case the requirement rests on. 404 — not 403 — and **byte-identical**
     * to an unknown id: a different answer would confirm that the id exists
     * somewhere on the platform, and form ids travel in URLs, mails and
     * exports.
     */
    it('answers 404 for a form of another organisation, exactly as for an unknown id', async () => {
      const alphaForm = await createForm(alphaAdmin, 'Nur für ALPHA');

      const foreign = await request(app().server)
        .get(apiPath(`/forms/${alphaForm.id}`))
        .set('Cookie', cookieHeader(betaAdmin));
      const unknown = await request(app().server)
        .get(apiPath('/forms/019fd000-0000-7000-8000-0000000000ff'))
        .set('Cookie', cookieHeader(betaAdmin));

      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(foreign.text).toBe(unknown.text);
      expect(foreign.text).toContain(FORM_NOT_FOUND_MESSAGE);
    });

    it('answers a malformed id the same way, rather than letting PostgreSQL raise', async () => {
      const malformed = await request(app().server)
        .get(apiPath('/forms/nicht-mal-eine-uuid'))
        .set('Cookie', cookieHeader(betaAdmin));

      expect(malformed.status).toBe(404);
      expect(malformed.text).toContain(FORM_NOT_FOUND_MESSAGE);
    });

    it('refuses to overwrite a form of another organisation', async () => {
      const alphaForm = await createForm(alphaAdmin, 'ALPHA schreibt');

      const response = await request(app().server)
        .put(apiPath(`/forms/${alphaForm.id}`))
        .set(authedMutation(betaAdmin))
        .send({
          title: 'BETA übernimmt',
          definition: definition(),
          revision: alphaForm.revision,
        });

      expect(response.status).toBe(404);
      const untouched = await app().prisma.form.findUnique({
        where: { id: alphaForm.id },
      });
      expect(untouched?.title).toBe('ALPHA schreibt');
    });

    it('never lists a form of another organisation', async () => {
      await createForm(alphaAdmin, 'ALPHAs Liste');

      const response = await request(app().server)
        .get(apiPath('/forms'))
        .set('Cookie', cookieHeader(betaAdmin));

      expect(response.status).toBe(200);
      // The whole payload is searched, not just the titles: an id or a slug
      // leaking through a nested field would pass a title-only check.
      expect(JSON.stringify(response.body)).not.toContain('ALPHAs Liste');
    });
  });

  describe('group permissions', () => {
    /**
     * Each permission is proven as a **pair**: one member without the flag
     * gets 403, one with it gets 200. A single-sided test would be satisfied
     * by a guard that refuses everyone, or by one that refuses no one.
     */
    it('refuses building to a member without canBuild and allows it with', async () => {
      const withoutBuild = await createRestrictedMember(app().prisma, alpha, {
        email: 'viewer-build@example.org',
        groupName: 'viewer-build',
        permissions: { canBuild: false, canViewResponses: true },
      });
      const withBuild = await createRestrictedMember(app().prisma, alpha, {
        email: 'editor-build@example.org',
        groupName: 'editor-build',
        permissions: { canBuild: true },
      });

      const denied = await openSession(app(), withoutBuild.id, alpha.id);
      const allowed = await openSession(app(), withBuild.id, alpha.id);

      // Asserted on **creating** a form, not on the list: the list
      // is open to either right (see the test below), so it can no longer tell
      // the two apart. Building can.
      const refused = await request(app().server)
        .post(apiPath('/forms'))
        .set(authedMutation(denied))
        .send({ title: 'Darf nicht' });
      const granted = await request(app().server)
        .post(apiPath('/forms'))
        .set(authedMutation(allowed))
        .send({ title: 'Darf' });

      expect(refused.status).toBe(403);
      expect(refused.text).toContain(MISSING_PERMISSION_MESSAGE);
      expect(granted.status).toBe(201);
    });

    /**
     * An open point, now closed: `GET /api/forms`
     * required `can_build`, so a member who may only see answers found no form
     * at all — their role listed a right they had no way to reach. Either
     * right opens the list; neither right closes it.
     */
    it('opens the form list to either right, and to neither without one', async () => {
      const viewer = await createRestrictedMember(app().prisma, alpha, {
        email: 'nur-antworten@example.org',
        groupName: 'nur-antworten',
        permissions: { canBuild: false, canViewResponses: true },
      });
      const nobody = await createRestrictedMember(app().prisma, alpha, {
        email: 'gar-nichts@example.org',
        groupName: 'gar-nichts',
        permissions: { canBuild: false, canViewResponses: false },
      });

      const asViewer = await openSession(app(), viewer.id, alpha.id);
      const asNobody = await openSession(app(), nobody.id, alpha.id);

      expect(
        (
          await request(app().server)
            .get(apiPath('/forms'))
            .set('Cookie', cookieHeader(asViewer))
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app().server)
            .get(apiPath('/forms'))
            .set('Cookie', cookieHeader(asNobody))
        ).status,
      ).toBe(403);
    });

    /**
     * The whole path a pure viewer walks, end to end.
     *
     * Opening the list was only the first half of the dead end: the responses
     * table renders the *questions*, and it reads them from `GET /forms/:id`.
     * Guarding that on `canBuild` alone meant the viewer saw the form on the
     * dashboard, pressed „Antworten" and got a load error — the same dead end
     * one click further along. Both routes are asserted here together, because
     * the promise is the path and not either route on its own.
     */
    it('lets a pure viewer walk list → form → answers', async () => {
      const form = await createForm(alphaAdmin, 'Weg des Auswerters');

      const viewer = await createRestrictedMember(app().prisma, alpha, {
        email: 'weg-auswerter@example.org',
        groupName: 'weg-auswerter',
        permissions: { canBuild: false, canViewResponses: true },
      });
      const session = await openSession(app(), viewer.id, alpha.id);

      for (const path of [
        '/forms',
        `/forms/${form.id}`,
        `/forms/${form.id}/responses`,
      ]) {
        const response = await request(app().server)
          .get(apiPath(path))
          .set('Cookie', cookieHeader(session));
        expect(response.status, `GET ${path} as a pure viewer`).toBe(200);
      }

      const detail = await request(app().server)
        .get(apiPath(`/forms/${form.id}`))
        .set('Cookie', cookieHeader(session));
      const document = detail.body as {
        definition: unknown;
        revision: number;
      };

      // …and the read-only half stops at reading: changing the form is still
      // `canBuild`, which this member does not have. Sent with a body the
      // server would otherwise accept, so the 403 is the guard's answer and
      // not a validation error wearing its number.
      const refused = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(session))
        .send({
          title: 'Umbenannt',
          definition: document.definition,
          revision: document.revision,
        });
      expect(refused.status).toBe(403);
    });

    it('refuses answers to a member without canViewResponses and allows them with', async () => {
      const form = await createForm(alphaAdmin, 'Antworten-Rechte');

      const withoutView = await createRestrictedMember(app().prisma, alpha, {
        email: 'no-responses@example.org',
        groupName: 'no-responses',
        permissions: { canBuild: true, canViewResponses: false },
      });
      const withView = await createRestrictedMember(app().prisma, alpha, {
        email: 'yes-responses@example.org',
        groupName: 'yes-responses',
        permissions: { canBuild: true, canViewResponses: true },
      });

      const denied = await openSession(app(), withoutView.id, alpha.id);
      const allowed = await openSession(app(), withView.id, alpha.id);

      const refused = await request(app().server)
        .get(apiPath(`/forms/${form.id}/responses`))
        .set('Cookie', cookieHeader(denied));
      const granted = await request(app().server)
        .get(apiPath(`/forms/${form.id}/responses`))
        .set('Cookie', cookieHeader(allowed));

      expect(refused.status).toBe(403);
      expect(granted.status).toBe(200);
    });

    /**
     * The reason the guard resolves the membership of the **active** tenant
     * rather than trusting a flattened permission set: someone may be admin in
     * their own Organisation and a viewer in the association, and the wider role must
     * not travel with them.
     */
    it('reads the permissions of the active tenant, not the widest one held', async () => {
      const person = await createRestrictedMember(app().prisma, beta, {
        email: 'zwei-rollen@example.org',
        groupName: 'beta-viewer',
        permissions: { canBuild: false },
      });
      // Same person, admin in ALPHA.
      await app().prisma.membership.create({
        data: {
          tenantId: alpha.id,
          userId: person.id,
          groupId: alpha.adminGroupId,
        },
      });

      const inAlpha = await openSession(app(), person.id, alpha.id);
      const inBeta = await openSession(app(), person.id, beta.id);

      expect(
        (
          await request(app().server)
            .get(apiPath('/forms'))
            .set('Cookie', cookieHeader(inAlpha))
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app().server)
            .get(apiPath('/forms'))
            .set('Cookie', cookieHeader(inBeta))
        ).status,
      ).toBe(403);
    });
  });

  describe('concurrent editors', () => {
    it('refuses the second save from the same starting state with 409', async () => {
      const form = await createForm(alphaAdmin, 'Zwei Bearbeiter');

      const first = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(alphaAdmin))
        .send({
          title: 'Erster Bearbeiter',
          definition: definition('Vorname'),
          revision: form.revision,
        });
      const second = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(alphaAdmin))
        // The same revision the first one started from — this is what two
        // people editing the same form in two tabs actually send.
        .send({
          title: 'Zweiter Bearbeiter',
          definition: definition('Nachname'),
          revision: form.revision,
        });

      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
      expect(second.text).toContain(STALE_REVISION_MESSAGE);

      // And the first editor's work is still there — which is the point.
      const stored = await app().prisma.form.findUnique({
        where: { id: form.id },
      });
      expect(stored?.title).toBe('Erster Bearbeiter');
    });

    it('accepts the second save once it names the revision it actually saw', async () => {
      const form = await createForm(alphaAdmin, 'Nacheinander');

      const first = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(alphaAdmin))
        .send({
          title: 'Erst',
          definition: definition(),
          revision: form.revision,
        });
      const body = first.body as { revision: number };

      const second = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(alphaAdmin))
        .send({
          title: 'Dann',
          definition: definition(),
          revision: body.revision,
        });

      expect(second.status).toBe(200);
    });
  });

  describe('publishing and the schema state per answer', () => {
    it('publishes the draft as version 1 and the next change as version 2', async () => {
      const form = await createForm(alphaAdmin, 'Veröffentlichen');

      const saved = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(alphaAdmin))
        .send({
          title: 'Veröffentlichen',
          definition: definition('Zuname'),
          revision: form.revision,
        });
      const afterSave = saved.body as { revision: number };

      const first = await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(alphaAdmin))
        .send({ revision: afterSave.revision });

      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        status: 'active',
        publishedVersion: 1,
      });

      // „the next change" is meant literally since 2026-07-27: a second publish
      // of the *same* document is refused, so the draft moves first.
      const changed = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(alphaAdmin))
        .send({
          title: 'Veröffentlichen',
          definition: definition('Vor- und Zuname'),
          revision: (first.body as { revision: number }).revision,
        });

      const second = await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(alphaAdmin))
        .send({ revision: (changed.body as { revision: number }).revision });

      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ publishedVersion: 2 });
    });

    /**
     * The requirement in one test: an answer keeps its meaning after the form has
     * moved on. The question is renamed *and* another is removed, and the old
     * submission still reports the version it was given — which is what the
     * responses table and the CSV export render it against.
     */
    it('keeps an old answer attached to the schema state it was submitted against', async () => {
      const form = await createForm(alphaAdmin, 'Revisionen');

      const saved = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(alphaAdmin))
        .send({
          title: 'Revisionen',
          definition: definition('Alter Fragetext'),
          revision: form.revision,
        });
      const published = await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(alphaAdmin))
        .send({ revision: (saved.body as { revision: number }).revision });

      const version = await app().prisma.formVersion.findFirstOrThrow({
        where: { formId: form.id },
        orderBy: { version: 'desc' },
      });
      await app().prisma.response.create({
        data: {
          tenantId: alpha.id,
          formId: form.id,
          formVersionId: version.id,
          answers: { '019fd000-0000-7000-8000-000000000001': 'Anton' },
        },
      });

      // The form moves on: the question is renamed and the form republished.
      await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(alphaAdmin))
        .send({
          title: 'Revisionen',
          definition: definition('Ganz anderer Fragetext'),
          revision: (published.body as { revision: number }).revision,
        });

      const responses = await request(app().server)
        .get(apiPath(`/forms/${form.id}/responses`))
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(responses.status).toBe(200);
      const rows = responses.body as {
        formVersion: number;
        answers: Record<string, unknown>;
      }[];
      expect(rows).toHaveLength(1);
      // Still version 1 — not the version the form is at now.
      expect(rows[0]?.formVersion).toBe(1);
      expect(rows[0]?.answers['019fd000-0000-7000-8000-000000000001']).toBe(
        'Anton',
      );

      // And the snapshot still carries the *old* wording, which is what makes
      // the export of a grown form readable rather than merely non-crashing.
      const snapshot = await app().prisma.formVersion.findUniqueOrThrow({
        where: { id: version.id },
      });
      expect(JSON.stringify(snapshot.schema)).toContain('Alter Fragetext');
    });

    /**
     * „Ohne Änderung ist Veröffentlichen gesperrt" (client decision,
     * 2026-07-27).
     *
     * Republishing an untouched draft used to mint a second, byte-identical
     * snapshot and raise the version number for nothing — which was at the same
     * time the only sign the button had done anything at all.
     *
     * Every case here **counts `form_version` rows before and after** rather
     * than reading the response. A refusal that still wrote a row would answer
     * 422 and leave the damage behind, and no status assertion could see it.
     */
    describe('publishing an unchanged draft (client decision, 2026-07-27)', () => {
      const versionCount = (formId: string): Promise<number> =>
        app().prisma.formVersion.count({ where: { formId } });

      /** Saves `body` as the draft and returns the revision to publish from. */
      async function save(
        formId: string,
        revision: number,
        definitionBody: unknown,
        title = 'Fassungen',
      ): Promise<number> {
        const saved = await request(app().server)
          .put(apiPath(`/forms/${formId}`))
          .set(authedMutation(alphaAdmin))
          .send({ title, definition: definitionBody, revision });
        expect(saved.status).toBe(200);
        return (saved.body as { revision: number }).revision;
      }

      /** A published form whose draft is exactly the version in force. */
      async function publishedForm(
        title: string,
      ): Promise<{ id: string; revision: number }> {
        const form = await createForm(alphaAdmin, title);
        const saved = await save(form.id, form.revision, definition(), title);
        const published = await request(app().server)
          .post(apiPath(`/forms/${form.id}/publish`))
          .set(authedMutation(alphaAdmin))
          .send({ revision: saved });
        expect(published.status).toBe(200);
        return {
          id: form.id,
          revision: (published.body as { revision: number }).revision,
        };
      }

      it('refuses it, with its own reason and without writing a version', async () => {
        const form = await publishedForm('Unverändert');
        const before = await versionCount(form.id);

        const again = await request(app().server)
          .post(apiPath(`/forms/${form.id}/publish`))
          .set(authedMutation(alphaAdmin))
          .send({ revision: form.revision });

        expect(again.status).toBe(422);
        expect(again.text).toContain(NOTHING_TO_PUBLISH_MESSAGE);
        // Not the „bitte neu laden" of a stale revision: the two refusals ask
        // for opposite reactions, and this one is not about anybody being
        // faster.
        expect(again.text).not.toContain(STALE_REVISION_MESSAGE);
        expect(await versionCount(form.id)).toBe(before);
      });

      /**
       * The refusal must not move `form.revision` either. A bumped revision
       * would make the editor's *next save* answer 409 — „jemand anderes hat
       * geändert" — over a publish that did nothing at all.
       */
      it('leaves the form untouched, so the next save still works', async () => {
        const form = await publishedForm('Weiterarbeiten');

        await request(app().server)
          .post(apiPath(`/forms/${form.id}/publish`))
          .set(authedMutation(alphaAdmin))
          .send({ revision: form.revision });

        const saved = await save(
          form.id,
          form.revision,
          definition('Nach dem Nein'),
          'Weiterarbeiten',
        );
        expect(saved).toBe(form.revision + 1);
      });

      /**
       * **The trap this whole rule could have fallen into.** `publishDiff` —
       * the obvious-looking signal — reports only what can hurt a stored
       * answer, so a reworded label produces an empty diff. Refusing on that
       * would lock an editor out of publishing real work, and the draft would
       * never reach a single participant.
       *
       * The empty diff is asserted here, so the test states *why* it is the
       * case that matters rather than merely exercising it.
       */
      it('publishes a reworded label, which the publish diff cannot see', async () => {
        const form = await publishedForm('Umformuliert');
        const before = await versionCount(form.id);

        const preview = await request(app().server)
          .get(apiPath(`/forms/${form.id}/publish-preview`))
          .set('Cookie', cookieHeader(alphaAdmin));

        const revision = await save(
          form.id,
          form.revision,
          definition('Vor- und Zuname'),
          'Umformuliert',
        );
        const afterEdit = await request(app().server)
          .get(apiPath(`/forms/${form.id}/publish-preview`))
          .set('Cookie', cookieHeader(alphaAdmin));
        expect((afterEdit.body as { changes: unknown }).changes).toEqual({
          removed: [],
          added: [],
          typeChanged: [],
        });
        // …and it looked exactly the same before the edit, so the diff cannot
        // tell the two states apart at all.
        expect((preview.body as { changes: unknown }).changes).toEqual(
          (afterEdit.body as { changes: unknown }).changes,
        );

        const published = await request(app().server)
          .post(apiPath(`/forms/${form.id}/publish`))
          .set(authedMutation(alphaAdmin))
          .send({ revision });

        expect(published.status).toBe(200);
        expect(published.body).toMatchObject({ publishedVersion: 2 });
        expect(await versionCount(form.id)).toBe(before + 1);
      });

      /** Nothing is in force yet, so there is nothing to compare against. */
      it('always allows the very first publication', async () => {
        const form = await createForm(alphaAdmin, 'Erstmals');
        const revision = await save(
          form.id,
          form.revision,
          definition(),
          'Erstmals',
        );
        expect(await versionCount(form.id)).toBe(0);

        const published = await request(app().server)
          .post(apiPath(`/forms/${form.id}/publish`))
          .set(authedMutation(alphaAdmin))
          .send({ revision });

        expect(published.status).toBe(200);
        expect(await versionCount(form.id)).toBe(1);
      });

      /**
       * The same verdict on the form itself, so the builder can lock its button
       * **before** the press. Read from the one route the builder loads.
       */
      it('reports on the form whether there is anything to publish', async () => {
        const form = await createForm(alphaAdmin, 'Ablesbar');
        const detailOf = async (): Promise<{
          hasUnpublishedChanges: boolean;
          revision: number;
        }> => {
          const response = await request(app().server)
            .get(apiPath(`/forms/${form.id}`))
            .set('Cookie', cookieHeader(alphaAdmin));
          expect(response.status).toBe(200);
          return response.body as {
            hasUnpublishedChanges: boolean;
            revision: number;
          };
        };

        // Never published: always something to do.
        expect((await detailOf()).hasUnpublishedChanges).toBe(true);

        const revision = await save(
          form.id,
          form.revision,
          definition(),
          'Ablesbar',
        );
        const published = await request(app().server)
          .post(apiPath(`/forms/${form.id}/publish`))
          .set(authedMutation(alphaAdmin))
          .send({ revision });
        expect(published.status).toBe(200);

        expect((await detailOf()).hasUnpublishedChanges).toBe(false);

        // A label-only edit — invisible to `publishDiff`, and the flag has to
        // see it or the button stays locked over publishable work.
        await save(
          form.id,
          (await detailOf()).revision,
          definition('Ganz anders'),
          'Ablesbar',
        );
        expect((await detailOf()).hasUnpublishedChanges).toBe(true);
      });

      /**
       * The flag stays off the wire of the list, which is what this asserts —
       * not a cost. `FormSummary` carrying it would mean comparing a snapshot
       * against a draft per card, for a fact no card displays.
       */
      it('keeps the flag off the dashboard list', async () => {
        const form = await publishedForm('Nicht in der Liste');

        const list = await request(app().server)
          .get(apiPath('/forms'))
          .set('Cookie', cookieHeader(alphaAdmin));

        expect(list.status).toBe(200);
        // `items`: `GET /forms` answers a page, not a bare array.
        const card = (list.body as { items: { id: string }[] }).items.find(
          (entry) => entry.id === form.id,
        );
        expect(card).toBeDefined();
        expect(card).not.toHaveProperty('hasUnpublishedChanges');
      });
    });

    it('refuses to publish from a stale revision', async () => {
      const form = await createForm(alphaAdmin, 'Veraltet');

      await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(alphaAdmin))
        .send({
          title: 'Veraltet',
          definition: definition(),
          revision: form.revision,
        });

      const response = await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(alphaAdmin))
        .send({ revision: form.revision });

      expect(response.status).toBe(409);
    });

    /**
     * The public address must not be derivable from the row. UUIDv7 is
     * time-ordered, so an id would have handed anyone who knows one form a
     * decent guess at its neighbours.
     */
    it('gives each form an unguessable public slug that is not its id', async () => {
      const first = await createForm(alphaAdmin, 'Slug A');
      const second = await createForm(alphaAdmin, 'Slug B');

      expect(first.publicSlug).not.toBe(first.id);
      expect(first.publicSlug).not.toBe(second.publicSlug);
      expect(first.publicSlug.length).toBeGreaterThanOrEqual(20);
    });
  });

  describe('CSV export', () => {
    /** A published form with two answers, ready to export. */
    async function formWithAnswers(): Promise<{
      id: string;
      questionId: string;
    }> {
      const form = await createForm(alphaAdmin, 'Export');
      const saved = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(alphaAdmin))
        .send({
          title: 'Export',
          definition: definition('Name'),
          revision: form.revision,
        });
      await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(alphaAdmin))
        .send({ revision: (saved.body as { revision: number }).revision });

      const version = await app().prisma.formVersion.findFirstOrThrow({
        where: { formId: form.id },
        orderBy: { version: 'desc' },
      });
      const questionId = '019fd000-0000-7000-8000-000000000001';
      for (const name of ['Anton', 'Berthold']) {
        await app().prisma.response.create({
          data: {
            tenantId: alpha.id,
            formId: form.id,
            formVersionId: version.id,
            answers: { [questionId]: name },
          },
        });
      }
      return { id: form.id, questionId };
    }

    it('exports the answers as a CSV file with a download name', async () => {
      const { id } = await formWithAnswers();

      const response = await request(app().server)
        .get(apiPath(`/forms/${id}/export.csv`))
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('export.csv');
      expect(response.text).toContain('Anton');
      expect(response.text).toContain('Berthold');
    });

    /**
     * The requirement in one test: the file follows the **visible view**, not
     * the whole table. Search and column selection are what the client has on
     * screen, and the export is built from nothing else.
     */
    it('follows the search term rather than exporting everything', async () => {
      const { id } = await formWithAnswers();

      const response = await request(app().server)
        .get(apiPath(`/forms/${id}/export.csv`))
        .query({ q: 'Anton' })
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(response.text).toContain('Anton');
      expect(response.text).not.toContain('Berthold');
    });

    it('follows the column selection', async () => {
      const { id, questionId } = await formWithAnswers();

      const only = await request(app().server)
        .get(apiPath(`/forms/${id}/export.csv`))
        .query({ columns: questionId })
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(only.text).toContain('Anton');
      // Without the timestamp column there is no date in the file.
      expect(only.text).not.toContain('Eingereicht am');
    });

    /**
     * The requirement through the **real route**: a Matrix 3×4 and a Tabelle 3
     * Spalten × 2 Zeilen come out of the file as three and per-cell columns.
     *
     * The shared package measures `buildCsv`; this measures the whole way —
     * the column set the route builds, the selection by question id, and the
     * expansion into per-cell columns on the way into the file. A selection
     * carries **question** ids (the wire deliberately has no part keys), so
     * this is also the test that would catch an expansion lost in the route.
     *
     * **And the requirement in the same place**, because it is the same header
     * row: a second answer over **four** rows widens the file to four blocks
     * although the form offers only two — the way from the stored JSONB
     * answers into the header row, which no unit test of the route sees. The
     * search run below is the second half of that and the reason why
     * `exportCsv` **filters first and builds the header list out of that**:
     * header and cells have to arise over the *same* rows.
     */
    it('writes one column per Matrixzeile and per Tabellenzelle', async () => {
      const GRID_PAGE = '019fd000-0000-7000-8000-0000000000b0';
      const MATRIX = '019fd000-0000-7000-8000-0000000000b1';
      const TABLE = '019fd000-0000-7000-8000-0000000000b2';

      const form = await createForm(alphaAdmin, 'Raster');
      const saved = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(alphaAdmin))
        .send({
          title: 'Raster',
          revision: form.revision,
          definition: {
            pages: [
              {
                id: GRID_PAGE,
                title: 'Seite 1',
                description: null,
                questions: [
                  {
                    id: MATRIX,
                    type: 'matrix',
                    label: 'Bewertung',
                    hint: null,
                    required: false,
                    width: 'full',
                    rows: [
                      { value: 'organisation', label: 'Organisation' },
                      { value: 'programm', label: 'Programm' },
                      { value: 'verpflegung', label: 'Verpflegung' },
                    ],
                    columns: [
                      { value: 'sehr-gut', label: 'Sehr gut' },
                      { value: 'gut', label: 'Gut' },
                      { value: 'neutral', label: 'Neutral' },
                      { value: 'schlecht', label: 'Schlecht' },
                    ],
                    multiple: false,
                  },
                  {
                    id: TABLE,
                    type: 'table',
                    label: 'Begleitpersonen',
                    hint: null,
                    required: false,
                    width: 'full',
                    columns: [
                      { key: 'name', label: 'Name', type: 'text' },
                      { key: 'anzahl', label: 'Anzahl', type: 'number' },
                      {
                        key: 'vegetarisch',
                        label: 'Vegetarisch',
                        type: 'checkbox',
                      },
                    ],
                    rows: 2,
                  },
                ],
              },
            ],
          },
        });
      await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(alphaAdmin))
        .send({ revision: (saved.body as { revision: number }).revision });

      const version = await app().prisma.formVersion.findFirstOrThrow({
        where: { formId: form.id },
        orderBy: { version: 'desc' },
      });
      await app().prisma.response.create({
        data: {
          tenantId: alpha.id,
          formId: form.id,
          formVersionId: version.id,
          answers: {
            [MATRIX]: { rows: { organisation: ['sehr-gut'] } },
            // The formula a participant may type into a free-text cell — it
            // has to arrive neutralised through this route too, not only
            // through `buildCsv` (the requirement's reproduction).
            [TABLE]: { cells: [{ name: '=1+1', vegetarisch: true }, {}] },
          },
        },
      });
      // The **second** answer, twice as long as the form offers rows — it
      // alone decides the width of the file.
      await app().prisma.response.create({
        data: {
          tenantId: alpha.id,
          formId: form.id,
          formVersionId: version.id,
          answers: {
            [TABLE]: {
              cells: Array.from({ length: 4 }, (_, index) => ({
                name: `Gast ${String(index + 1)}`,
              })),
            },
          },
        },
      });

      /** The header row of the file, in its order. */
      const headerOf = (csv: string): string[] | undefined =>
        csv
          .replace(/^\ufeff/u, '')
          .split('\r\n')[0]
          ?.split(';');

      const exported = await request(app().server)
        .get(apiPath(`/forms/${form.id}/export.csv`))
        .query({ columns: [MATRIX, TABLE].join(',') })
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(exported.status).toBe(200);
      // Four blocks per cell type although the form offers two rows: the
      // header row follows the **longest** answer, not the document.
      expect(headerOf(exported.text)).toStrictEqual([
        'Bewertung — Organisation',
        'Bewertung — Programm',
        'Bewertung — Verpflegung',
        'Begleitpersonen — Name (Zeile 1)',
        'Begleitpersonen — Name (Zeile 2)',
        'Begleitpersonen — Name (Zeile 3)',
        'Begleitpersonen — Name (Zeile 4)',
        'Begleitpersonen — Anzahl (Zeile 1)',
        'Begleitpersonen — Anzahl (Zeile 2)',
        'Begleitpersonen — Anzahl (Zeile 3)',
        'Begleitpersonen — Anzahl (Zeile 4)',
        'Begleitpersonen — Vegetarisch (Zeile 1)',
        'Begleitpersonen — Vegetarisch (Zeile 2)',
        'Begleitpersonen — Vegetarisch (Zeile 3)',
        'Begleitpersonen — Vegetarisch (Zeile 4)',
      ]);
      expect(exported.text).toContain("'=1+1");
      expect(exported.text).toContain('Gast 4');

      // **The header list arises out of the *filtered* rows** : the search
      // term hits only the short answer, so the file stops at row two. If the
      // route builds the header list out of `parsed` again instead of out of
      // `filtered`, it carries „Zeile 3" and „Zeile 4" over columns in which no
      // row of this file ever has a value.
      const searched = await request(app().server)
        .get(apiPath(`/forms/${form.id}/export.csv`))
        .query({ columns: [MATRIX, TABLE].join(','), q: '1+1' })
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(searched.status).toBe(200);
      expect(headerOf(searched.text)).toStrictEqual([
        'Bewertung — Organisation',
        'Bewertung — Programm',
        'Bewertung — Verpflegung',
        'Begleitpersonen — Name (Zeile 1)',
        'Begleitpersonen — Name (Zeile 2)',
        'Begleitpersonen — Anzahl (Zeile 1)',
        'Begleitpersonen — Anzahl (Zeile 2)',
        'Begleitpersonen — Vegetarisch (Zeile 1)',
        'Begleitpersonen — Vegetarisch (Zeile 2)',
      ]);
      expect(searched.text).not.toContain('Gast');
    });

    /**
     * **The requirement, the evidence, through the real route** — and a
     * finding of a review: the evidence existed, guarded it was not.
     *
     * Two promises in one file, and both are visible at all only at exactly
     * this place:
     *
     * 1. **Four columns per address**, in the order of the handoff, with the
     *    header `Frage — Teil`.
     * 2. **`01067` stays `01067`.** The postcode column is protected as
     *    `'text'`, so an apostrophe stands in front of it — visible in Excel,
     *    and the price for the leading zero not disappearing. The other way
     *    round (`'auto'` or `'number'`) `1067` comes out; that is the probe
     *    the requirement explicitly demands.
     *
     * The **damaged** row beside it is a review finding on the same route: a
     * part field that is not a string aborted the whole export with a
     * `TypeError`. It stands *between* two healthy rows, so that „die Datei
     * überlebt" cannot mean „die Datei endet früher".
     */
    it('writes four columns per address and keeps a leading zero', async () => {
      const ADDRESS_PAGE = '019fd000-0000-7000-8000-0000000000c0';
      const ADDRESS = '019fd000-0000-7000-8000-0000000000c1';

      const form = await createForm(alphaAdmin, 'Anschriften');
      const saved = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(alphaAdmin))
        .send({
          title: 'Anschriften',
          revision: form.revision,
          definition: {
            pages: [
              {
                id: ADDRESS_PAGE,
                title: 'Seite 1',
                description: null,
                questions: [
                  {
                    id: ADDRESS,
                    type: 'address',
                    label: 'Anschrift',
                    hint: null,
                    required: false,
                    width: 'full',
                  },
                ],
              },
            ],
          },
        });
      await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(alphaAdmin))
        .send({ revision: (saved.body as { revision: number }).revision });

      const version = await app().prisma.formVersion.findFirstOrThrow({
        where: { formId: form.id },
        orderBy: { version: 'desc' },
      });
      const answers = [
        {
          street: 'Hauptstraße 1',
          zip: '01067',
          city: 'Dresden',
          country: 'Deutschland',
        },
        // What this application did not write — a hand on the JSONB column, an
        // import, an older version.
        { street: { strasse: 'Nebenweg 2' }, zip: 5, city: 'Meißen' },
        {
          street: 'Ringstraße 3',
          zip: '01069',
          city: 'Dresden',
          country: 'Deutschland',
        },
      ];
      for (const answer of answers) {
        await app().prisma.response.create({
          data: {
            tenantId: alpha.id,
            formId: form.id,
            formVersionId: version.id,
            answers: { [ADDRESS]: answer },
          },
        });
      }

      const exported = await request(app().server)
        .get(apiPath(`/forms/${form.id}/export.csv`))
        .query({ columns: ADDRESS })
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(exported.status).toBe(200);
      const lines = exported.text.replace(/^\ufeff/u, '').split('\r\n');
      expect(lines[0]?.split(';')).toStrictEqual([
        'Anschrift — Straße & Hausnummer',
        'Anschrift — PLZ',
        'Anschrift — Ort',
        'Anschrift — Land',
      ]);

      // the evidence: the leading zero survives, because the column stays text.
      expect(exported.text).toContain("'01067");
      expect(exported.text).not.toContain(';1067;');

      // Three answers, three rows — the damaged one cost its own cells and
      // nothing else.
      const rows = lines.slice(1).filter((line) => line !== '');
      expect(rows).toHaveLength(3);
      expect(rows[1]).toContain('Meißen');
      expect(rows[1]).not.toContain('Nebenweg');
    });

    /**
     * The search runs over the **rendered** row, timestamp included. The
     * server used to search only the answers, so a search for a date listed
     * rows in the table and produced a file with nothing but a header — the
     * export following a different view from the one on screen, which is
     * exactly what the requirement forbids.
     */
    it('finds a row by its submission date, as the table does', async () => {
      const { id } = await formWithAnswers();

      const all = await request(app().server)
        .get(apiPath(`/forms/${id}/export.csv`))
        .set('Cookie', cookieHeader(alphaAdmin));
      // `TT.MM.JJJJ HH:MM` in UTC — take the date the file itself printed, so
      // the assertion cannot drift from the formatting.
      const day = /(\d{2}\.\d{2}\.\d{4}) \d{2}:\d{2}/u.exec(all.text)?.[1];
      expect(day).toBeDefined();

      const byDate = await request(app().server)
        .get(apiPath(`/forms/${id}/export.csv`))
        .query({ q: day })
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(byDate.text).toContain('Anton');
      expect(byDate.text).toContain('Berthold');
    });

    /**
     * **The format stands in the address** .
     *
     * `export.csv` is the same URL it always was — that is the first half, and
     * it is what every other test in this block already measures. The second
     * half is what happens to `export.xyz`: the extension is a route parameter
     * now, so something has to say which ones exist. A **400 naming the
     * formats**, not a 404 (the form is there and the caller may export it) and
     * above all not a silent CSV under a foreign file name, which is how a
     * `.xlsx` that opens in no spreadsheet gets shipped.
     *
     * `.xlsx` and `.html` **left** this list at earlier points — both
     * have a writer now, and the blocks below measure what they produce. What
     * stays are extensions that name no format at all; the line turns red the
     * day somebody adds one to the enum without a writer behind it.
     */
    it('refuses an export format that has no writer, and names the ones that have', async () => {
      const { id } = await formWithAnswers();

      for (const extension of ['pdf', 'txt', 'csv.exe']) {
        const refused = await request(app().server)
          .get(apiPath(`/forms/${id}/export.${extension}`))
          .set('Cookie', cookieHeader(alphaAdmin));

        expect(refused.status).toBe(400);
        expect(refused.body).toMatchObject({
          message: expect.stringContaining('csv') as unknown,
        });
        // Nothing of what was asked for comes back out — the value is straight
        // out of the URL, and an echo would make this route a reflector.
        expect(JSON.stringify(refused.body)).not.toContain(extension);
      }
    });

    /**
     * **Excel through the real route** .
     *
     * The shared package measures the writer (`export-xlsx.test.ts`, the requirement cell by cell). What only this level can measure is the way *into* it:
     * that the route serves a workbook rather than text under an `.xlsx` name,
     * that it hands the writer the **filtered** rows, and that the permission
     * pair holds for the new extension as it does for `csv` — a guard that
     * covered one format and not the other is exactly the shape of the two
     * leaks that were once found.
     */
    describe('Excel-Export', () => {
      /**
       * The workbook, read back as rows of the value a reader takes from each
       * cell.
       *
       * The mapping is the same one for the comparison —
       * „den entschärften im CSV gegen den typisierten in Excel": a date cell
       * becomes the timestamp spelling the CSV writes, a number cell the German
       * decimal spelling. Anything else is the string it is.
       */
      async function readWorkbook(body: Buffer): Promise<string[][]> {
        const workbook = new ExcelJS.Workbook();
        const bytes = new ArrayBuffer(body.byteLength);
        new Uint8Array(bytes).set(body);
        await workbook.xlsx.load(bytes);

        const worksheet = workbook.worksheets[0];
        if (worksheet === undefined) {
          throw new Error('the workbook carries no worksheet');
        }
        const width = worksheet.getRow(1).cellCount;

        return Array.from({ length: worksheet.rowCount }, (_, rowIndex) =>
          Array.from({ length: width }, (_, index) => {
            const value = worksheet
              .getRow(rowIndex + 1)
              .getCell(index + 1).value;
            if (value === null || value === undefined) {
              return '';
            }
            if (value instanceof Date) {
              return formatTimestamp(value.toISOString());
            }
            if (typeof value === 'number') {
              return String(value).replace('.', ',');
            }
            if (typeof value === 'string') {
              return value;
            }
            throw new Error(`unexpected cell shape: ${JSON.stringify(value)}`);
          }),
        );
      }

      /**
       * The CSV, read back the same way — quoting undone and the formula
       * guard's leading apostrophe removed, so both sides are compared as what
       * they **say**.
       *
       * A split rather than a parser: the answers of this fixture carry no
       * delimiter, quote or line break, and the shared suite compares the two
       * formats over a fixture that does (`export-xlsx.test.ts`).
       */
      function readCsv(text: string): string[][] {
        return (
          text
            // The BOM as an escape — an invisible byte in a source file is a
            // defect waiting for a copy-paste.
            .replace(/^\ufeff/u, '')
            .split('\r\n')
            .filter((line) => line !== '')
            .map((line) =>
              line
                .split(';')
                .map((cell) =>
                  cell.startsWith("'")
                    ? cell.slice(1)
                    : cell.replace(/^"|"$/gu, ''),
                ),
            )
        );
      }

      /**
       * **the evidence.** The download name is the form's title, slugified, with
       * the format's extension — the *same* rule the CSV follows, in the same
       * place (`slugifyFilename` in `forms.service.ts`), so the two names cannot
       * drift apart.
       *
       * And the body is a **workbook**: `PK` is the first two bytes of every zip
       * archive, which is the cheapest proof that Express did not serialise the
       * writer's `Uint8Array` as JSON — an `.xlsx` full of `{"0":80,"1":75,…}`
       * that opens nowhere and would satisfy every other assertion here.
       */
      it('liefert eine Arbeitsmappe unter dem Namen des Formulars', async () => {
        const { id } = await formWithAnswers();

        const response = await request(app().server)
          .get(apiPath(`/forms/${id}/export.xlsx`))
          .responseType('blob')
          .set('Cookie', cookieHeader(alphaAdmin));

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain(
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        expect(response.headers['content-disposition']).toContain(
          'filename="export.xlsx"',
        );
        const body = response.body as Buffer;
        expect([body[0], body[1]]).toStrictEqual([0x50, 0x4b]);
      });

      /**
       * **the evidence, at the route.** Both formats are asked for the *same*
       * view and compared over the rows and columns they produced.
       *
       * The case with a search term is the one that matters: it is where „die
       * Zeilenmenge für Excel neu ermitteln, statt die des CSV zu benutzen"
       * shows up. Both files then carry one answer, not two — and the
       * comparison is over the produced files rather than over the input, so a
       * second row set cannot hide in a helper.
       */
      it.each([
        ['ohne Suche', undefined, 2],
        ['mit Suche', 'Anton', 1],
      ] as const)(
        'trägt %s dieselben Zeilen und Spalten wie die CSV',
        async (_name, search, expectedRows) => {
          const { id } = await formWithAnswers();
          const query = search === undefined ? {} : { q: search };

          const csv = await request(app().server)
            .get(apiPath(`/forms/${id}/export.csv`))
            .query(query)
            .set('Cookie', cookieHeader(alphaAdmin));
          const xlsx = await request(app().server)
            .get(apiPath(`/forms/${id}/export.xlsx`))
            .query(query)
            .responseType('blob')
            .set('Cookie', cookieHeader(alphaAdmin));

          expect(csv.status).toBe(200);
          expect(xlsx.status).toBe(200);

          const fromCsv = readCsv(csv.text);
          const fromXlsx = await readWorkbook(xlsx.body as Buffer);

          // Header row plus the expected answer rows — in **both** files,
          // counted by what they carry.
          expect(fromCsv).toHaveLength(expectedRows + 1);
          expect(fromXlsx).toHaveLength(expectedRows + 1);
          // Same column order, same rows, same values.
          expect(fromXlsx).toStrictEqual(fromCsv);
        },
      );

      /**
       * **the evidence, first half.** The pair belongs to the *route*, not to
       * the format — both halves, as every permission test in this file: without
       * the flag 403, with it 200.
       */
      it('verweigert den Excel-Export ohne canExport und erlaubt ihn mit', async () => {
        const { id } = await formWithAnswers();

        const withoutExport = await createRestrictedMember(
          app().prisma,
          alpha,
          {
            email: 'kein-excel@example.org',
            groupName: 'kein-excel',
            permissions: {
              canBuild: true,
              canViewResponses: true,
              canExport: false,
            },
          },
        );
        const withExport = await createRestrictedMember(app().prisma, alpha, {
          email: 'mit-excel@example.org',
          groupName: 'mit-excel',
          permissions: {
            canBuild: true,
            canViewResponses: true,
            canExport: true,
          },
        });

        const denied = await openSession(app(), withoutExport.id, alpha.id);
        const allowed = await openSession(app(), withExport.id, alpha.id);

        const refused = await request(app().server)
          .get(apiPath(`/forms/${id}/export.xlsx`))
          .set('Cookie', cookieHeader(denied));
        const granted = await request(app().server)
          .get(apiPath(`/forms/${id}/export.xlsx`))
          .responseType('blob')
          .set('Cookie', cookieHeader(allowed));

        expect(refused.status).toBe(403);
        expect(refused.text).toContain(MISSING_PERMISSION_MESSAGE);
        // And nothing of the file came through the refusal.
        expect(refused.text).not.toContain('Anton');
        expect(granted.status).toBe(200);
      });

      /**
       * `can_export` is an **addition** to being allowed to see the answers, in
       * every format. A group with export but without `can_view_responses` must
       * not reach the workbook either.
       */
      it('verweigert den Excel-Export an canExport ohne canViewResponses', async () => {
        const { id } = await formWithAnswers();

        const exportOnly = await createRestrictedMember(app().prisma, alpha, {
          email: 'nur-excel@example.org',
          groupName: 'nur-excel',
          permissions: {
            canBuild: false,
            canViewResponses: false,
            canExport: true,
          },
        });
        const session = await openSession(app(), exportOnly.id, alpha.id);

        const refused = await request(app().server)
          .get(apiPath(`/forms/${id}/export.xlsx`))
          .set('Cookie', cookieHeader(session));

        expect(refused.status).toBe(403);
        expect(refused.text).toContain(MISSING_PERMISSION_MESSAGE);
        expect(refused.text).not.toContain('Anton');
      });

      /**
       * **the evidence, second half:** across the tenant boundary **404**, not
       * 403 — the form of another organisation does not exist for this session, and the
       * status must not say otherwise.
       */
      it('exportiert niemals das Formular einer anderen Organisation als Excel', async () => {
        const { id } = await formWithAnswers();

        const response = await request(app().server)
          .get(apiPath(`/forms/${id}/export.xlsx`))
          .set('Cookie', cookieHeader(betaAdmin));

        expect(response.status).toBe(404);
        expect(response.text).not.toContain('Anton');
      });
    });

    /**
     * **The HTML export through the real route** .
     *
     * The writer itself is measured line by line in `packages/shared`
     * (`export-html.test.ts`: neutralisation, embedded styles, line breaks).
     * What **only** this level can measure is the header: `writeHtml` takes
     * title, organisation and moment as its second argument, and formerly the
     * route never passed it along — the file an editor downloaded carried the
     * neutral default header, while the tests of the writer stood green on a
     * meta that no caller sent.
     *
     * That is why the evidence stands here and not there. Exactly the same gap
     * could arise for `.xlsx` (every header field right, content as JSON) and
     * both times became visible only at the route.
     */
    describe('HTML-Export', () => {
      /**
       * **the evidence, the printed header.** Form title, organisation and
       * moment — the three details the sheet itself does not carry, and the
       * three that make a printed participant list assignable in the first
       * place.
       */
      it('druckt Formulartitel, Organisation und Zeitpunkt in den Kopf', async () => {
        const { id } = await formWithAnswers();
        const before = Date.now();

        const response = await request(app().server)
          .get(apiPath(`/forms/${id}/export.html`))
          .set('Cookie', cookieHeader(alphaAdmin));

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toBe(
          'text/html; charset=utf-8',
        );
        expect(response.headers['content-disposition']).toBe(
          'attachment; filename="export.html"',
        );

        // The title of the form, not the default „Antworten" — and the name
        // of the organisation, which only the server knows.
        expect(response.text).toContain('<h1>Export</h1>');
        expect(response.text).toContain('Organisation ALPHA');
        expect(response.text).not.toContain('<h1>Antworten</h1>');

        // The moment is **this** retrieval. Measured against the calendar day
        // instead of the second: the second would be a race condition, the
        // date is the statement („wann wurde exportiert"). Computed in UTC,
        // because the writer writes in UTC and says so — a test in the zone of
        // the machine would be red at night and green during the day.
        const at = new Date(before);
        const pad = (value: number): string => String(value).padStart(2, '0');
        const day = `${pad(at.getUTCDate())}.${pad(at.getUTCMonth() + 1)}.${String(at.getUTCFullYear())}`;
        expect(response.text).toContain(`Stand: ${day}`);
        expect(response.text).toContain('UTC');

        // And the rows are in it — a header over an empty table would be no
        // export.
        expect(response.text).toContain('Anton');
        expect(response.text).toContain('Berthold');
      });

      /**
       * **The search filters this format too** (the evidence, third writer).
       * The same assurance `writeExport` holds structurally — proven here over
       * the route, because it is exactly here that the row set arises.
       */
      it('schreibt nur die gefundenen Zeilen', async () => {
        const { id } = await formWithAnswers();

        const response = await request(app().server)
          .get(apiPath(`/forms/${id}/export.html`))
          .query({ q: 'Anton' })
          .set('Cookie', cookieHeader(alphaAdmin));

        expect(response.status).toBe(200);
        expect(response.text).toContain('Anton');
        expect(response.text).not.toContain('Berthold');
      });

      /**
       * The permission pair holds for **every** format — a guard that covers
       * CSV and Excel and not HTML is the shape of the two leaks.
       */
      it('verlangt canViewResponses **und** canExport, und bleibt im Organisation', async () => {
        const { id } = await formWithAnswers();

        const exportOnly = await createRestrictedMember(app().prisma, alpha, {
          email: 'nur-html@example.org',
          groupName: 'nur-html',
          permissions: {
            canBuild: false,
            canViewResponses: false,
            canExport: true,
          },
        });
        const session = await openSession(app(), exportOnly.id, alpha.id);

        const refused = await request(app().server)
          .get(apiPath(`/forms/${id}/export.html`))
          .set('Cookie', cookieHeader(session));
        // Across the organisation boundary 404, not 403: the form does not
        // exist for this session, and the status must not say anything else.
        const foreign = await request(app().server)
          .get(apiPath(`/forms/${id}/export.html`))
          .set('Cookie', cookieHeader(betaAdmin));

        expect(refused.status).toBe(403);
        expect(refused.text).toContain(MISSING_PERMISSION_MESSAGE);
        expect(refused.text).not.toContain('Anton');
        expect(foreign.status).toBe(404);
        expect(foreign.text).not.toContain('Anton');
      });
    });

    /**
     * The pair could not be proven earlier, because no export route existed
     * to show it on. Both halves, as every permission test in this file:
     * without the flag 403, with it 200.
     */
    it('refuses the export without canExport and allows it with', async () => {
      const { id } = await formWithAnswers();

      const withoutExport = await createRestrictedMember(app().prisma, alpha, {
        email: 'kein-export@example.org',
        groupName: 'kein-export',
        permissions: {
          canBuild: true,
          canViewResponses: true,
          canExport: false,
        },
      });
      const withExport = await createRestrictedMember(app().prisma, alpha, {
        email: 'mit-export@example.org',
        groupName: 'mit-export',
        permissions: {
          canBuild: true,
          canViewResponses: true,
          canExport: true,
        },
      });

      const denied = await openSession(app(), withoutExport.id, alpha.id);
      const allowed = await openSession(app(), withExport.id, alpha.id);

      const refused = await request(app().server)
        .get(apiPath(`/forms/${id}/export.csv`))
        .set('Cookie', cookieHeader(denied));
      const granted = await request(app().server)
        .get(apiPath(`/forms/${id}/export.csv`))
        .set('Cookie', cookieHeader(allowed));

      expect(refused.status).toBe(403);
      expect(refused.text).toContain(MISSING_PERMISSION_MESSAGE);
      expect(granted.status).toBe(200);
    });

    /**
     * `can_export` is an **addition** to being allowed to see the answers, not
     * a way around it. A group with export but without `can_view_responses` —
     * which is freely configurable — must not be able to download every
     * answer of the organisation while being unable to open a single one on screen.
     * A bulk file of personal data is the stronger right, not the weaker one.
     */
    it('refuses the export to canExport without canViewResponses', async () => {
      const { id } = await formWithAnswers();

      const exportOnly = await createRestrictedMember(app().prisma, alpha, {
        email: 'nur-export@example.org',
        groupName: 'nur-export',
        permissions: {
          canBuild: false,
          canViewResponses: false,
          canExport: true,
        },
      });
      const session = await openSession(app(), exportOnly.id, alpha.id);

      const refused = await request(app().server)
        .get(apiPath(`/forms/${id}/export.csv`))
        .set('Cookie', cookieHeader(session));

      expect(refused.status).toBe(403);
      expect(refused.text).toContain(MISSING_PERMISSION_MESSAGE);
      // And nothing of the file leaked through the refusal.
      expect(refused.text).not.toContain('Anton');
    });

    /**
     * The phone guard, through the real route (client decision 2026-07-27).
     *
     * Both spellings, because the point is that they are treated alike: the
     * an acceptance run showed `+49 …` neutralised and `01603884482` untouched — and the
     * untouched one reaches Excel as a *number*, without its leading zero.
     */
    it('keeps every phone number text, however it is written', async () => {
      const form = await createForm(alphaAdmin, 'Telefon-Export');
      const phoneId = '019fd000-0000-7000-8000-0000000000c1';
      const withPhone = {
        pages: [
          {
            id: '019fd000-0000-7000-8000-0000000000c0',
            title: 'Seite 1',
            questions: [
              {
                id: phoneId,
                type: 'phone',
                label: 'Telefon',
                hint: null,
                required: false,
                width: 'full',
              },
            ],
          },
        ],
      };

      const saved = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(alphaAdmin))
        .send({
          title: 'Telefon-Export',
          definition: withPhone,
          revision: form.revision,
        });
      // Asserted rather than assumed: a failed save would otherwise surface
      // further down as `findFirstOrThrow`, in the wrong place with the wrong
      // message.
      expect(saved.status).toBe(200);

      const published = await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(alphaAdmin))
        .send({ revision: (saved.body as { revision: number }).revision });
      expect(published.status).toBe(200);

      const version = await app().prisma.formVersion.findFirstOrThrow({
        where: { formId: form.id },
        orderBy: { version: 'desc' },
      });
      for (const number of ['+49 6421 123456', '01603884482']) {
        await app().prisma.response.create({
          data: {
            tenantId: alpha.id,
            formId: form.id,
            formVersionId: version.id,
            answers: { [phoneId]: number },
          },
        });
      }

      const response = await request(app().server)
        .get(apiPath(`/forms/${form.id}/export.csv`))
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(response.status).toBe(200);
      expect(response.text).toContain("'+49 6421 123456");
      expect(response.text).toContain("'01603884482");
    });

    it('never exports a form of another organisation', async () => {
      const { id } = await formWithAnswers();

      const response = await request(app().server)
        .get(apiPath(`/forms/${id}/export.csv`))
        .set('Cookie', cookieHeader(betaAdmin));

      expect(response.status).toBe(404);
      expect(response.text).not.toContain('Anton');
    });
  });

  describe('the definition is validated on the way in', () => {
    it('refuses a definition with an unknown question type and names the path', async () => {
      const form = await createForm(alphaAdmin, 'Ungültig');
      /*
       * Deliberately a type that will never exist. This used to say `rating`,
       * "the realistic mistake" — and then a later change built it, at which point the
       * definition failed on a missing `max` instead of on the type, and the
       * assertion on the path went red for a reason that had nothing to do with
       * what it measures. A case that names a not-yet-built type dates itself
       * to the milestone that builds it.
       */
      const broken = brokenDefinition({ type: 'kein-solcher-typ' });

      const response = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(alphaAdmin))
        .send({
          title: 'Ungültig',
          definition: broken,
          revision: form.revision,
        });

      expect(response.status).toBe(400);
      expect(response.text).toContain('pages.0.questions.0.type');
    });

    it('refuses a pattern that does not compile, before anyone fills the form in', async () => {
      const form = await createForm(alphaAdmin, 'Kaputtes Muster');
      const broken = brokenDefinition({ pattern: '([a-z' });

      const response = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(alphaAdmin))
        .send({ title: 'Muster', definition: broken, revision: form.revision });

      expect(response.status).toBe(400);
    });
  });

  /**
   * Konzept no. 22 and no. 23, through the real routes.
   *
   * The regression these two decisions come from is the first test below, and
   * it is the kind that stays silent: the answers to a removed question were
   * still in the database and no longer reachable through the interface,
   * because the columns were read off the **draft**. Everything here is
   * therefore asserted on the *removed* question — a suite that only checks the
   * surviving column would have stayed green through the whole defect.
   */
  describe('the responses view of a form that has changed (Nr. 22, Nr. 23)', () => {
    const PAGE = '019fd000-0000-7000-8000-0000000000d0';
    const NAME = '019fd000-0000-7000-8000-0000000000d1';
    const PHONE = '019fd000-0000-7000-8000-0000000000d2';
    const DIET = '019fd000-0000-7000-8000-0000000000d3';
    /** The id a type change mints for the phone question (no. 24, no. 26). */
    const RETYPED = '019fd000-0000-7000-8000-0000000000d4';

    const base = { hint: null, required: false, width: 'full' } as const;
    const nameQuestion = {
      ...base,
      id: NAME,
      type: 'text',
      label: 'Name',
      minLength: null,
      maxLength: null,
      pattern: null,
    };
    const phoneQuestion = {
      ...base,
      id: PHONE,
      type: 'phone',
      label: 'Telefon',
    };
    /** The same id as the phone question, one type further — a legacy document. */
    const phoneAsNumber = {
      ...base,
      id: PHONE,
      type: 'number',
      label: 'Telefon',
      min: null,
      max: null,
      integer: true,
    };
    /** The same question one type further, as no. 24 writes it: a **new** id. */
    const retypedPhone = {
      ...base,
      id: RETYPED,
      type: 'number',
      label: 'Telefon',
      min: null,
      max: null,
      integer: true,
    };
    const dietQuestion = {
      ...base,
      id: DIET,
      type: 'text',
      label: 'Essenswunsch',
      minLength: null,
      maxLength: null,
      pattern: null,
    };

    function withQuestions(questions: readonly unknown[]): unknown {
      return { pages: [{ id: PAGE, title: 'Seite 1', questions }] };
    }

    /** Saves a draft and returns the revision the next call has to name. */
    async function saveDraft(
      formId: string,
      revision: number,
      questions: readonly unknown[],
      title = 'Anmeldung',
    ): Promise<number> {
      const saved = await request(app().server)
        .put(apiPath(`/forms/${formId}`))
        .set(authedMutation(alphaAdmin))
        .send({ title, definition: withQuestions(questions), revision });
      // Asserted rather than assumed: a rejected save would otherwise surface
      // three steps later as a missing column, in the wrong place.
      expect(saved.status).toBe(200);
      return (saved.body as { revision: number }).revision;
    }

    async function publish(formId: string, revision: number): Promise<number> {
      const published = await request(app().server)
        .post(apiPath(`/forms/${formId}/publish`))
        .set(authedMutation(alphaAdmin))
        .send({ revision });
      expect(published.status).toBe(200);
      return (published.body as { revision: number }).revision;
    }

    /** An answer against the version currently in force. */
    async function submit(
      formId: string,
      answers: Record<string, string>,
    ): Promise<void> {
      const version = await app().prisma.formVersion.findFirstOrThrow({
        where: { formId },
        orderBy: { version: 'desc' },
      });
      await app().prisma.response.create({
        data: {
          tenantId: alpha.id,
          formId,
          formVersionId: version.id,
          answers,
        },
      });
    }

    /**
     * A form published twice: version 1 asks for name **and** phone, version 2
     * only for the name. One answer under each.
     */
    async function formWithRetiredQuestion(): Promise<string> {
      const form = await createForm(alphaAdmin, 'Anmeldung');
      let revision = await saveDraft(form.id, form.revision, [
        nameQuestion,
        phoneQuestion,
      ]);
      revision = await publish(form.id, revision);
      await submit(form.id, { [NAME]: 'Anton', [PHONE]: '06421 123456' });

      revision = await saveDraft(form.id, revision, [nameQuestion]);
      await publish(form.id, revision);
      await submit(form.id, { [NAME]: 'Berthold' });

      return form.id;
    }

    interface ColumnSet {
      columns: { key: string; label: string; retired: boolean }[];
      versions: { version: number; definition: { pages: unknown[] } }[];
    }

    function columnsOf(body: unknown): ColumnSet {
      return body as ColumnSet;
    }

    /**
     * **The regression.** Before no. 22 this exported a file without the phone
     * column at all: the answer was in the database, the editor could not get
     * at it, and nothing said so.
     */
    it('still exports the answers to a question that was removed', async () => {
      const formId = await formWithRetiredQuestion();

      const csv = await request(app().server)
        .get(apiPath(`/forms/${formId}/export.csv`))
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(csv.status).toBe(200);
      expect(csv.text).toContain('Telefon');
      // The apostrophe is the phone guard of the **row's own** version — the
      // only place that still knows this question was a phone number. Nothing
      // about the value asks for it: `06421 123456` is neither a formula nor a
      // digit string a spreadsheet would re-read, so the guard can only have
      // come from the type.
      expect(csv.text).toContain("'06421 123456");
      expect(csv.text).toContain('Anton');
      expect(csv.text).toContain('Berthold');
    });

    it('exports the retired column when the client asks for it by key', async () => {
      const formId = await formWithRetiredQuestion();

      const csv = await request(app().server)
        .get(apiPath(`/forms/${formId}/export.csv`))
        .query({ columns: PHONE })
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(csv.status).toBe(200);
      expect(csv.text).toContain("'06421 123456");
    });

    /**
     * The table half of the same promise. The route hands over the union *and*
     * the snapshots, because a cell of the retired column can only be rendered
     * against the version that still had the question.
     */
    it('offers the removed question as a column, marked as no longer active', async () => {
      const formId = await formWithRetiredQuestion();

      const response = await request(app().server)
        .get(apiPath(`/forms/${formId}/responses/columns`))
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(response.status).toBe(200);
      const { columns, versions } = columnsOf(response.body);

      expect(columns.map((column) => column.key)).toEqual([
        NAME,
        PHONE,
        '__submitted_at__',
      ]);
      expect(columns.find((column) => column.key === PHONE)).toMatchObject({
        label: 'Telefon',
        retired: true,
      });
      expect(columns.find((column) => column.key === NAME)?.retired).toBe(
        false,
      );

      // Both snapshots travel with it, so the row submitted under version 1
      // renders against a definition that still has the phone question.
      expect(versions.map((version) => version.version)).toEqual([1, 2]);
      expect(JSON.stringify(versions[0])).toContain(PHONE);
      expect(JSON.stringify(versions[1])).not.toContain(PHONE);
    });

    /**
     * The second half of no. 22, and the one nobody would have found by
     * looking: the columns came from `draft_schema`, so **editing** the builder
     * changed the responses view — without saving a version, without
     * publishing, for everyone looking at the answers.
     */
    it('ignores the draft entirely — an unpublished edit changes nothing', async () => {
      const form = await createForm(alphaAdmin, 'Entwurf');
      let revision = await saveDraft(
        form.id,
        form.revision,
        [nameQuestion, phoneQuestion],
        'Entwurf',
      );
      revision = await publish(form.id, revision);
      await submit(form.id, { [NAME]: 'Anton', [PHONE]: '06421 123456' });

      // Removed in the draft and *not* published.
      await saveDraft(form.id, revision, [nameQuestion], 'Entwurf');

      const columns = await request(app().server)
        .get(apiPath(`/forms/${form.id}/responses/columns`))
        .set('Cookie', cookieHeader(alphaAdmin));
      const csv = await request(app().server)
        .get(apiPath(`/forms/${form.id}/export.csv`))
        .set('Cookie', cookieHeader(alphaAdmin));

      const phone = columnsOf(columns.body).columns.find(
        (column) => column.key === PHONE,
      );
      expect(phone).toBeDefined();
      // Still **active**: the published form asks the question, whatever the
      // builder happens to have open.
      expect(phone?.retired).toBe(false);
      expect(csv.text).toContain("'06421 123456");
    });

    it('names removed, added and retyped questions before publishing again', async () => {
      const form = await createForm(alphaAdmin, 'Vorschau');
      let revision = await saveDraft(
        form.id,
        form.revision,
        [nameQuestion, phoneQuestion],
        'Vorschau',
      );
      revision = await publish(form.id, revision);
      await submit(form.id, { [NAME]: 'Anton', [PHONE]: '06421 123456' });

      // The draft the editor is about to publish: the name goes, a wish
      // arrives, and the phone question changes type — the shape the legacy
      // document now avoids, which the preview still has to be able to describe.
      await saveDraft(
        form.id,
        revision,
        [phoneAsNumber, dietQuestion],
        'Vorschau',
      );

      const preview = await request(app().server)
        .get(apiPath(`/forms/${form.id}/publish-preview`))
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({
        publishedVersion: 1,
        responseCount: 1,
        changes: {
          removed: [{ id: NAME, label: 'Name', type: 'text' }],
          added: [{ id: DIET, label: 'Essenswunsch', type: 'text' }],
          typeChanged: [
            { id: PHONE, label: 'Telefon', from: 'phone', to: 'number' },
          ],
        },
      });
    });

    /**
     * Konzept no. 24, end to end — and the half a unit test cannot show:
     * the reference has to **survive the store**. It travels inside
     * `draft_schema`, is written as JSONB and read back through
     * `formDefinitionSchema`, which strips every key it does not know. Before
     * the field existed in the schema, a builder writing it would have watched
     * it disappear silently on the way to the database, with the preview then
     * reporting the removal and the addition it was meant to prevent.
     */
    it('reads the retyped question as one change, not as a removal plus an addition', async () => {
      const form = await createForm(alphaAdmin, 'Typwechsel');
      let revision = await saveDraft(
        form.id,
        form.revision,
        [nameQuestion, phoneQuestion],
        'Typwechsel',
      );
      revision = await publish(form.id, revision);
      await submit(form.id, { [NAME]: 'Anton', [PHONE]: '06421 123456' });

      // What the builder writes from no. 24 on: a new id, and the reference
      // back to the one it stands in for.
      await saveDraft(
        form.id,
        revision,
        [nameQuestion, { ...retypedPhone, replaces: PHONE }],
        'Typwechsel',
      );

      const preview = await request(app().server)
        .get(apiPath(`/forms/${form.id}/publish-preview`))
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({
        publishedVersion: 1,
        responseCount: 1,
        changes: {
          removed: [],
          added: [],
          typeChanged: [
            { id: RETYPED, label: 'Telefon', from: 'phone', to: 'number' },
          ],
        },
      });
    });

    it('reads a first publish as all additions, with no answers on file', async () => {
      const form = await createForm(alphaAdmin, 'Erstveröffentlichung');
      await saveDraft(
        form.id,
        form.revision,
        [nameQuestion],
        'Erstveröffentlichung',
      );

      const preview = await request(app().server)
        .get(apiPath(`/forms/${form.id}/publish-preview`))
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({
        publishedVersion: null,
        responseCount: 0,
        changes: {
          removed: [],
          added: [{ id: NAME, type: 'text' }],
          typeChanged: [],
        },
      });
    });

    /**
     * The preview states the revision it describes, so the client can tell
     * a verdict about a draft somebody has since changed. Publishing itself is
     * untouched — the preview refuses nothing (no. 23: „der Bearbeiter
     * entscheidet weiterhin selbst").
     */
    it('carries the revision it describes, and publishing stays open', async () => {
      const formId = await formWithRetiredQuestion();
      const loaded = await request(app().server)
        .get(apiPath(`/forms/${formId}`))
        .set('Cookie', cookieHeader(alphaAdmin));
      // `formWithRetiredQuestion` leaves the draft exactly as it published it,
      // and since 2026-07-27 that is refused for its own reason. Something has
      // to be different, or the refusal under test here would never be reached.
      const revision = await saveDraft(
        formId,
        (loaded.body as { revision: number }).revision,
        [{ ...nameQuestion, label: 'Vor- und Zuname' }],
      );

      const preview = await request(app().server)
        .get(apiPath(`/forms/${formId}/publish-preview`))
        .set('Cookie', cookieHeader(alphaAdmin));
      expect((preview.body as { revision: number }).revision).toBe(revision);

      const published = await request(app().server)
        .post(apiPath(`/forms/${formId}/publish`))
        .set(authedMutation(alphaAdmin))
        .send({ revision });
      expect(published.status).toBe(200);
    });

    /**
     * Both new routes through the guard chain, each as a **pair** — the way
     * every permission in this file is proven.
     */
    it('guards the columns on canViewResponses and the preview on canBuild', async () => {
      const formId = await formWithRetiredQuestion();

      const viewer = await createRestrictedMember(app().prisma, alpha, {
        email: 'nr22-viewer@example.org',
        groupName: 'nr22-viewer',
        permissions: { canBuild: false, canViewResponses: true },
      });
      const builder = await createRestrictedMember(app().prisma, alpha, {
        email: 'nr22-builder@example.org',
        groupName: 'nr22-builder',
        permissions: { canBuild: true, canViewResponses: false },
      });

      const asViewer = await openSession(app(), viewer.id, alpha.id);
      const asBuilder = await openSession(app(), builder.id, alpha.id);

      const columnsPath = `/forms/${formId}/responses/columns`;
      const previewPath = `/forms/${formId}/publish-preview`;

      const columnsAllowed = await request(app().server)
        .get(apiPath(columnsPath))
        .set('Cookie', cookieHeader(asViewer));
      const columnsRefused = await request(app().server)
        .get(apiPath(columnsPath))
        .set('Cookie', cookieHeader(asBuilder));
      const previewAllowed = await request(app().server)
        .get(apiPath(previewPath))
        .set('Cookie', cookieHeader(asBuilder));
      const previewRefused = await request(app().server)
        .get(apiPath(previewPath))
        .set('Cookie', cookieHeader(asViewer));

      expect(columnsAllowed.status).toBe(200);
      expect(columnsRefused.status).toBe(403);
      expect(columnsRefused.text).toContain(MISSING_PERMISSION_MESSAGE);
      // …and the refusal carried none of the form's questions with it.
      expect(columnsRefused.text).not.toContain('Telefon');

      expect(previewAllowed.status).toBe(200);
      expect(previewRefused.status).toBe(403);
      expect(previewRefused.text).toContain(MISSING_PERMISSION_MESSAGE);
    });

    it('names the retired column in the CSV header', async () => {
      const formId = await formWithRetiredQuestion();

      const csv = await request(app().server)
        .get(apiPath(`/forms/${formId}/export.csv`))
        .set('Cookie', cookieHeader(alphaAdmin));

      // The file leaves the application for good and is opened by somebody who
      // never saw the form; without the note an empty cell reads as „nicht
      // ausgefüllt" rather than „danach nicht mehr gefragt".
      expect(csv.text).toContain('Telefon (nicht mehr gefragt)');
      // …and the active column keeps the plain question text.
      expect(csv.text).toContain('Name;');
      expect(csv.text).not.toContain('Name (nicht mehr gefragt)');
    });

    it('offers the timestamp alone for a form that was never published', async () => {
      const form = await createForm(alphaAdmin, 'Nie veröffentlicht');
      await saveDraft(
        form.id,
        form.revision,
        [nameQuestion, phoneQuestion],
        'Nie veröffentlicht',
      );

      const response = await request(app().server)
        .get(apiPath(`/forms/${form.id}/responses/columns`))
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(response.status).toBe(200);
      const { columns, versions } = columnsOf(response.body);
      // The draft has two questions and contributes none of them: nothing was
      // ever asked, so there is nothing to show and nothing to answer.
      expect(columns.map((column) => column.key)).toEqual(['__submitted_at__']);
      expect(versions).toEqual([]);
    });

    /**
     * Only the versions answers actually point at travel with the columns. A
     * form republished through a semester carries a dozen documents nobody
     * would ever render a cell against.
     */
    it('sends the snapshots that answers point at, not every version ever published', async () => {
      const form = await createForm(alphaAdmin, 'Viele Fassungen');
      let revision = await saveDraft(
        form.id,
        form.revision,
        [nameQuestion, phoneQuestion],
        'Viele Fassungen',
      );
      revision = await publish(form.id, revision);
      // Version 2: published, never answered.
      revision = await saveDraft(
        form.id,
        revision,
        [nameQuestion, phoneQuestion, dietQuestion],
        'Viele Fassungen',
      );
      revision = await publish(form.id, revision);
      // Version 3, the one the answer is given under.
      revision = await saveDraft(
        form.id,
        revision,
        [nameQuestion, dietQuestion],
        'Viele Fassungen',
      );
      await publish(form.id, revision);
      await submit(form.id, { [NAME]: 'Anton' });

      const response = await request(app().server)
        .get(apiPath(`/forms/${form.id}/responses/columns`))
        .set('Cookie', cookieHeader(alphaAdmin));

      const { columns, versions } = columnsOf(response.body);
      // Every version still contributes its questions…
      expect(columns.map((column) => column.key)).toEqual([
        NAME,
        DIET,
        PHONE,
        '__submitted_at__',
      ]);
      // …but only the answered one travels as a document.
      expect(versions.map((version) => version.version)).toEqual([3]);
      // And the row id of the version row stays on the server.
      expect(Object.keys(versions[0] ?? {}).sort()).toEqual([
        'definition',
        'version',
      ]);
    });

    /**
     * A stored snapshot that no longer parses — a hand-edited row, a migration
     * that went wrong. All three routes stay usable, and the degradation is
     * pinned rather than described: the questions of the damaged version are
     * gone, everything else survives, and if the damaged one is the *newest*,
     * the one before it is taken for the current form — so a question removed
     * in the newest version is reported as still **active**.
     */
    it('survives a damaged snapshot, and says how it degrades', async () => {
      const form = await createForm(alphaAdmin, 'Beschädigt');
      let revision = await saveDraft(
        form.id,
        form.revision,
        [nameQuestion, phoneQuestion],
        'Beschädigt',
      );
      revision = await publish(form.id, revision);
      await submit(form.id, { [NAME]: 'Anton', [PHONE]: '06421 123456' });

      revision = await saveDraft(
        form.id,
        revision,
        [nameQuestion],
        'Beschädigt',
      );
      await publish(form.id, revision);

      const newest = await app().prisma.formVersion.findFirstOrThrow({
        where: { formId: form.id },
        orderBy: { version: 'desc' },
      });
      await app().prisma.formVersion.update({
        where: { id: newest.id },
        data: { schema: { pages: 'kaputt' } },
      });

      const columns = await request(app().server)
        .get(apiPath(`/forms/${form.id}/responses/columns`))
        .set('Cookie', cookieHeader(alphaAdmin));
      const csv = await request(app().server)
        .get(apiPath(`/forms/${form.id}/export.csv`))
        .set('Cookie', cookieHeader(alphaAdmin));
      const responses = await request(app().server)
        .get(apiPath(`/forms/${form.id}/responses`))
        .set('Cookie', cookieHeader(alphaAdmin));
      const preview = await request(app().server)
        .get(apiPath(`/forms/${form.id}/publish-preview`))
        .set('Cookie', cookieHeader(alphaAdmin));

      // Usable, not a 500: the view is the only way to the answers behind the
      // versions that are still intact.
      expect(columns.status).toBe(200);
      expect(csv.status).toBe(200);
      expect(responses.status).toBe(200);
      expect(preview.status).toBe(200);
      expect(csv.text).toContain("'06421 123456");

      // The preview reads an unreadable version in force as "nothing was
      // published": every question is an addition. It overstates the change and
      // never understates it, which is the safe direction for a warning.
      expect(preview.body).toMatchObject({
        responseCount: 1,
        changes: {
          removed: [],
          added: [{ id: NAME, type: 'text' }],
          typeChanged: [],
        },
      });

      // The documented degradation: version 1 is now taken for the current
      // form, so the question it *was* asking counts as active again.
      const phone = columnsOf(columns.body).columns.find(
        (column) => column.key === PHONE,
      );
      expect(phone?.retired).toBe(false);
      expect(csv.text).not.toContain('nicht mehr gefragt');
    });

    /**
     * **The regression.** The export used to *drop* a row whose snapshot no
     * longer parses, while the table kept it — so the screen said „2 Antworten"
     * and the file had one line, with nothing anywhere saying which one was
     * missing. Decided on 2026-07-27: the export follows the table.
     *
     * The damaged version here is the **oldest** one, the one an answer was
     * actually given under — the existing degradation test damages the newest,
     * where no row is affected.
     */
    it('keeps the row of a damaged snapshot in the file, as the table keeps it', async () => {
      const formId = await formWithRetiredQuestion();
      const answered = await app().prisma.formVersion.findFirstOrThrow({
        where: { formId },
        orderBy: { version: 'asc' },
      });
      await app().prisma.formVersion.update({
        where: { id: answered.id },
        data: { schema: { pages: 'kaputt' } },
      });
      const damagedRow = await app().prisma.response.findFirstOrThrow({
        where: { formVersionId: answered.id },
      });

      const csv = await request(app().server)
        .get(apiPath(`/forms/${formId}/export.csv`))
        .set('Cookie', cookieHeader(alphaAdmin));
      const responses = await request(app().server)
        .get(apiPath(`/forms/${formId}/responses`))
        .set('Cookie', cookieHeader(alphaAdmin));
      const detail = await request(app().server)
        .get(apiPath(`/forms/${formId}`))
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(csv.status).toBe(200);
      const lines = csv.text.split('\r\n').filter((line) => line !== '');

      // Header plus **both** answers. The damaged one carries its timestamp and
      // is otherwise empty — the same cells the table shows for it.
      expect(lines).toHaveLength(3);
      expect(lines).toContain(
        `;${formatTimestamp(damagedRow.submittedAt.toISOString())}`,
      );
      expect(lines.some((line) => line.startsWith('Berthold;'))).toBe(true);

      // The three places that count answers must say the same number: the file,
      // the list the table renders, and the „N Antworten" of the form itself.
      expect((responses.body as unknown[]).length).toBe(2);
      expect(detail.body).toMatchObject({ responseCount: 2 });
    });

    /**
     * The same door as every other form route: **byte-identical** to an
     * unknown id, not merely a 404 as well. A differently shaped error would
     * confirm that the id exists somewhere on the platform, and form ids travel
     * in URLs, mails and exports.
     */
    it('answers both routes for a form of another organisation exactly as for an unknown id', async () => {
      const formId = await formWithRetiredQuestion();
      const unknownId = '019fd000-0000-7000-8000-0000000000fe';

      for (const route of ['responses/columns', 'publish-preview']) {
        const foreign = await request(app().server)
          .get(apiPath(`/forms/${formId}/${route}`))
          .set('Cookie', cookieHeader(betaAdmin));
        const unknown = await request(app().server)
          .get(apiPath(`/forms/${unknownId}/${route}`))
          .set('Cookie', cookieHeader(betaAdmin));

        expect(foreign.status, `GET ${route} as another organisation`).toBe(
          404,
        );
        expect(unknown.status, `GET ${route} for an unknown id`).toBe(404);
        expect(foreign.text, `GET ${route}`).toBe(unknown.text);
        expect(foreign.text).toContain(FORM_NOT_FOUND_MESSAGE);
        expect(foreign.text).not.toContain('Telefon');
      }
    });
  });
});
