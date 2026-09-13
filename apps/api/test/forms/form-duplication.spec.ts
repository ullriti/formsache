import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FORM_NOT_FOUND_MESSAGE } from '../../src/forms/forms.service';
import { MISSING_PERMISSION_MESSAGE } from '../../src/tenancy/group-permission.guard';
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
import { NO_SECTIONS } from '../support/settings-sections';
import { authedMutation, cookieHeader, openSession } from '../support/http';

/**
 * Duplicating a question and a form.
 *
 * Written the way `CONTRIBUTING.md` asks of a rights or isolation rule — every
 * guarantee is asserted through the case that has to **fail** — plus the
 * requirement's own three traps, each with the reproduction it names:
 *
 * 1. **New ids, everywhere they matter.** A condition and a notification's
 *    placeholder/recipient both name a question by id; both are checked
 *    against the *new* id, not merely "some id changed". *Reproduction:*
 *    keeping the original ids would leave both pointing at the source form —
 *    the id-equality assertions below would fail exactly that way.
 * 2. **The access word does not travel.** *Reproduction:* copying
 *    `settings_override` verbatim would carry the sealed word along and the
 *    duplicate's settings read would either surface it or fail to open (wrong
 *    context) — either way the "no password" assertion goes red.
 * 3. **The duplicate is not a dead document.** It is published and filled in
 *    through the public route in the same test that duplicates it, which is
 *    the one proof that compares fields cannot give.
 */

const PASSWORD = 'test-password';

describe('duplicating a form ', () => {
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
      email: 'alpha-dup@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    const betaUser = await createUser(testApp.prisma, {
      email: 'beta-dup@example.org',
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

  const PAGE = '019fe900-0000-7000-8000-0000000000a0';
  const NAME_QUESTION = '019fe900-0000-7000-8000-000000000001';
  /** Conditional on `NAME_QUESTION` — proves the cross-question id rewrite. */
  const FOLLOWUP_QUESTION = '019fe900-0000-7000-8000-000000000002';

  function questionDefinition(): unknown {
    return {
      pages: [
        {
          id: PAGE,
          title: 'Seite 1',
          questions: [
            {
              // `email`, not `text`: the recipient below names this question,
              // and `ADDRESS_QUESTION_TYPES` — a deliberate allow list — only
              // ever offers an `email` question as a mail address source.
              id: NAME_QUESTION,
              type: 'email',
              label: 'E-Mail',
              hint: null,
              required: true,
              width: 'full',
            },
            {
              id: FOLLOWUP_QUESTION,
              type: 'text',
              label: 'Anmerkung',
              hint: null,
              required: false,
              width: 'full',
              minLength: null,
              maxLength: null,
              pattern: null,
              visibleIf: { questionId: NAME_QUESTION, operator: 'filled' },
            },
          ],
        },
      ],
    };
  }

  interface FormBody {
    id: string;
    revision: number;
    publicSlug: string;
    title: string;
    status: string;
    publishedVersion: number | null;
    definition: {
      pages: {
        questions: { id: string; visibleIf?: { questionId: string } }[];
      }[];
    };
  }

  /** A fully built form: two questions, an access word, and a notification. */
  async function buildFullForm(
    token: string,
    title = 'Bestandsmeldung',
  ): Promise<{ form: FormBody; notificationId: string }> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(token))
      .send({ title });
    expect(created.status).toBe(201);
    const form = created.body as FormBody;

    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(token))
      .send({
        title,
        definition: questionDefinition(),
        revision: form.revision,
      });
    expect(saved.status).toBe(200);

    const settingsRow = await app().prisma.form.findUniqueOrThrow({
      where: { id: form.id },
      select: { settingsRevision: true, tenantId: true },
    });
    const tenantRow = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: settingsRow.tenantId },
      select: { formDefaultsRevision: true },
    });
    const settingsWritten = await request(app().server)
      .put(apiPath(`/forms/${form.id}/settings`))
      .set(authedMutation(token))
      .send({
        revision: settingsRow.settingsRevision,
        tenantRevision: tenantRow.formDefaultsRevision,
        overridden: { ...NO_SECTIONS, access: true },
        values: { passwordEnabled: true, password: 'jahrestagung-2026-zugang' },
      });
    expect(settingsWritten.status).toBe(200);

    const notificationCreated = await request(app().server)
      .post(apiPath(`/forms/${form.id}/notifications`))
      .set(authedMutation(token))
      .send({
        name: 'Bestätigung',
        subject: `Danke, {{frage:${NAME_QUESTION}}}`,
        body: `Wir melden uns bei {{frage:${NAME_QUESTION}}}.`,
        replyTo: null,
        recipients: [{ kind: 'question', questionId: NAME_QUESTION }],
      });
    expect(notificationCreated.status).toBe(201);

    const reread = await request(app().server)
      .get(apiPath(`/forms/${form.id}`))
      .set('Cookie', cookieHeader(token));
    return {
      form: reread.body as FormBody,
      notificationId: (notificationCreated.body as { id: string }).id,
    };
  }

  async function duplicate(
    token: string,
    formId: string,
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/forms/${formId}/duplicate`))
      .set(authedMutation(token));
  }

  describe('what travels, and what does not', () => {
    it('gives every question a new id and rewrites the condition between them', async () => {
      const { form } = await buildFullForm(alphaAdmin, 'Fragen duplizieren');

      const response = await duplicate(alphaAdmin, form.id);
      expect(response.status).toBe(201);
      const copy = response.body as FormBody;

      const [copyName, copyFollowup] =
        copy.definition.pages[0]?.questions ?? [];
      expect(copyName?.id).toBeDefined();
      expect(copyFollowup?.id).toBeDefined();

      // Reproduction named by the requirement: keeping the old ids would make
      // these four assertions pass by accident. They must be **new**.
      expect(copyName?.id).not.toBe(NAME_QUESTION);
      expect(copyFollowup?.id).not.toBe(FOLLOWUP_QUESTION);

      // …and the condition follows its source to the new id, not the old one.
      expect(copyFollowup?.visibleIf?.questionId).toBe(copyName?.id);
      expect(copyFollowup?.visibleIf?.questionId).not.toBe(NAME_QUESTION);
    });

    it('is a fresh draft: its own public address, no version, no responses', async () => {
      const { form } = await buildFullForm(alphaAdmin, 'Entwurf duplizieren');

      const copy = (await duplicate(alphaAdmin, form.id)).body as FormBody;

      expect(copy.status).toBe('draft');
      expect(copy.publishedVersion).toBeNull();
      expect(copy.publicSlug).not.toBe(form.publicSlug);

      const versions = await app().prisma.formVersion.count({
        where: { formId: copy.id },
      });
      const responses = await app().prisma.response.count({
        where: { formId: copy.id },
      });
      expect(versions).toBe(0);
      expect(responses).toBe(0);
    });

    it('names the copy after the original, with the suffix the prototype uses', async () => {
      const { form } = await buildFullForm(
        alphaAdmin,
        'Jahrestagung-Anmeldung',
      );
      const copy = (await duplicate(alphaAdmin, form.id)).body as FormBody;

      expect(copy.title).toBe('Jahrestagung-Anmeldung (Kopie)');
    });

    /**
     * The trap the requirement names in as many words: an access word is
     * decryptable, so a duplicate carrying the sealed bytes over would put a
     * secret nobody set for it in reach of `can_manage_settings` on the copy.
     */
    it('does not carry the access word over, and switches protection off', async () => {
      const { form } = await buildFullForm(alphaAdmin, 'Mit Zugangswort');
      const copy = (await duplicate(alphaAdmin, form.id)).body as FormBody;

      const copySettings = await request(app().server)
        .get(apiPath(`/forms/${copy.id}/settings`))
        .set('Cookie', cookieHeader(alphaAdmin));
      expect(copySettings.status).toBe(200);
      const settings = copySettings.body as {
        values: { password?: string; passwordEnabled?: boolean };
        effective: { password: string; passwordEnabled: boolean };
      };

      expect(settings.values.password).toBe('');
      expect(settings.values.passwordEnabled).toBe(false);
      expect(settings.effective.passwordEnabled).toBe(false);

      // Not just absent from the response — never stored in clear or under
      // the original's ciphertext either.
      const row = await app().prisma.form.findUniqueOrThrow({
        where: { id: copy.id },
      });
      expect(JSON.stringify(row.settingsOverride)).not.toContain(
        'jahrestagung-2026-zugang',
      );
    });

    it('rewrites the notification’s placeholder and recipient onto the new question id', async () => {
      const { form } = await buildFullForm(alphaAdmin, 'Mit Benachrichtigung');
      const copy = (await duplicate(alphaAdmin, form.id)).body as FormBody;
      const newQuestionId = copy.definition.pages[0]?.questions[0]?.id;
      if (newQuestionId === undefined) {
        throw new Error('expected the duplicated question to have an id');
      }

      const notifications = await request(app().server)
        .get(apiPath(`/forms/${copy.id}/notifications`))
        .set('Cookie', cookieHeader(alphaAdmin));
      expect(notifications.status).toBe(200);
      const [notification] = (
        notifications.body as {
          notifications: {
            subject: string;
            body: string;
            recipients: { kind: string; questionId?: string }[];
          }[];
        }
      ).notifications;

      expect(notification?.subject).toBe(`Danke, {{frage:${newQuestionId}}}`);
      expect(notification?.body).toBe(
        `Wir melden uns bei {{frage:${newQuestionId}}}.`,
      );
      expect(notification?.recipients).toEqual([
        { kind: 'question', questionId: newQuestionId },
      ]);
      // The old id is gone from both places a placeholder could hide it.
      expect(notification?.subject).not.toContain(NAME_QUESTION);
      expect(
        notification?.recipients.some(
          (recipient) => recipient.questionId === NAME_QUESTION,
        ),
      ).toBe(false);
    });
  });

  /**
   * The proof the requirement asks for over field comparisons: the copy is not
   * a dead document, it goes through the real public path end to end.
   */
  it('can be published and filled in like any other form', async () => {
    const { form } = await buildFullForm(alphaAdmin, 'Muss funktionieren');
    const copy = (await duplicate(alphaAdmin, form.id)).body as FormBody;
    const copyQuestionId = copy.definition.pages[0]?.questions[0]?.id;
    if (copyQuestionId === undefined) {
      throw new Error('expected the duplicated question to have an id');
    }

    const published = await request(app().server)
      .post(apiPath(`/forms/${copy.id}/publish`))
      .set(authedMutation(alphaAdmin))
      .send({ revision: copy.revision });
    expect(published.status).toBe(200);

    const submitted = await request(app().server)
      .post(apiPath(`/public/forms/${copy.publicSlug}/responses`))
      .send({ answers: { [copyQuestionId]: 'anton@example.org' } });
    expect(submitted.status).toBe(200);

    const stored = await app().prisma.response.findFirst({
      where: { formId: copy.id },
    });
    expect(stored?.answers).toMatchObject({
      [copyQuestionId]: 'anton@example.org',
    });
  });

  describe('rights and tenant isolation', () => {
    it('refuses duplicating without canBuild and allows it with', async () => {
      const { form } = await buildFullForm(alphaAdmin, 'Rechteprüfung');

      const withoutBuild = await createRestrictedMember(app().prisma, alpha, {
        email: 'viewer-dup@example.org',
        groupName: 'viewer-dup',
        permissions: { canBuild: false, canViewResponses: true },
      });
      const withBuild = await createRestrictedMember(app().prisma, alpha, {
        email: 'editor-dup@example.org',
        groupName: 'editor-dup',
        permissions: { canBuild: true },
      });
      const denied = await openSession(app(), withoutBuild.id, alpha.id);
      const allowed = await openSession(app(), withBuild.id, alpha.id);

      const refused = await duplicate(denied, form.id);
      const granted = await duplicate(allowed, form.id);

      expect(refused.status).toBe(403);
      expect(refused.text).toContain(MISSING_PERMISSION_MESSAGE);
      expect(granted.status).toBe(201);
    });

    /**
     * **The fourth link of the chain, measured at this route** (a review finding).
     *
     * Up to here this file only checked the organisation-wide `canBuild` rule — the
     * *third* link. `POST :id/duplicate` inherits the per-form restriction solely
     * over the class decorator of `FormsController`, and inherited means: decided
     * by nobody for this route. A route that falls out of the
     * guard list (or gets a `@UseGuards` line that shortens the chain)
     * would look exactly as before — except for this case.
     *
     * Both verdicts stand here, because they are **two different answers**
     * and the difference is decided: `revoked` is 404, byte for byte like an
     * unknown form, `capped-out` is 403 — the form exists, this
     * person is merely not allowed *this* here. And both additionally measure that
     * **nothing** has come into being: a copy that stands in the table despite a
     * refusal would be the actual violation.
     */
    describe('the fourth link — the per-form restriction', () => {
      /**
       * A member with `canBuild` (otherwise the third link would already
       * refuse and the case would prove nothing) plus a row in
       * `form_permission`.
       */
      async function restrictedBuilder(options: {
        readonly email: string;
        readonly groupName: string;
        readonly formId: string;
        readonly accessRevoked: boolean;
        readonly cappedGroupId: string | null;
      }): Promise<string> {
        const member = await createRestrictedMember(app().prisma, alpha, {
          email: options.email,
          groupName: options.groupName,
          permissions: { canBuild: true, canViewResponses: true },
        });
        await app().prisma.formPermission.create({
          data: {
            tenantId: alpha.id,
            formId: options.formId,
            userId: member.id,
            accessRevoked: options.accessRevoked,
            cappedGroupId: options.cappedGroupId,
          },
        });
        return openSession(app(), member.id, alpha.id);
      }

      it('answers 404 for a form the caller is locked out of, exactly as for an unknown id', async () => {
        const { form } = await buildFullForm(alphaAdmin, 'Gesperrtes Formular');
        const before = await app().prisma.form.count({
          where: { tenantId: alpha.id },
        });

        const locked = await restrictedBuilder({
          email: 'revoked-dup@example.org',
          groupName: 'revoked-dup',
          formId: form.id,
          accessRevoked: true,
          cappedGroupId: null,
        });

        const refused = await duplicate(locked, form.id);
        const unknown = await duplicate(
          locked,
          '019fe900-0000-7000-8000-0000000000fe',
        );

        expect(refused.status).toBe(404);
        // The same answer as for a form that does not exist: a 403
        // here would betray that the form exists and that somebody deliberately
        // locked this person out.
        expect(refused.text).toBe(unknown.text);
        expect(refused.text).toContain(FORM_NOT_FOUND_MESSAGE);
        expect(
          await app().prisma.form.count({ where: { tenantId: alpha.id } }),
        ).toBe(before);
      });

      it('answers 403 for a caller capped to a role without canBuild', async () => {
        const { form } = await buildFullForm(
          alphaAdmin,
          'Gedeckeltes Formular',
        );
        const before = await app().prisma.form.count({
          where: { tenantId: alpha.id },
        });

        // The role that is capped to: sees responses, does not build.
        const cap = await app().prisma.group.create({
          data: {
            tenantId: alpha.id,
            name: 'nur-lesen-dup',
            color: '#5b6b52',
            rank: 30,
            isSystem: false,
            canBuild: false,
            canViewResponses: true,
            canExport: false,
            canManageSettings: false,
            canManageFormSettings: false,
            canManageUsers: false,
          },
        });
        const capped = await restrictedBuilder({
          email: 'capped-dup@example.org',
          groupName: 'capped-dup',
          formId: form.id,
          accessRevoked: false,
          cappedGroupId: cap.id,
        });

        const refused = await duplicate(capped, form.id);

        expect(refused.status).toBe(403);
        expect(refused.text).toContain(MISSING_PERMISSION_MESSAGE);
        expect(
          await app().prisma.form.count({ where: { tenantId: alpha.id } }),
        ).toBe(before);
      });
    });

    it('answers 404 for a form of another organisation, exactly as for an unknown id, and creates nothing', async () => {
      const { form } = await buildFullForm(alphaAdmin, 'Fremdes Formular');
      const formsBefore = await app().prisma.form.count({
        where: { tenantId: beta.id },
      });

      const foreign = await duplicate(betaAdmin, form.id);
      const unknown = await duplicate(
        betaAdmin,
        '019fe900-0000-7000-8000-0000000000ff',
      );

      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(foreign.text).toBe(unknown.text);
      expect(foreign.text).toContain(FORM_NOT_FOUND_MESSAGE);

      const formsAfter = await app().prisma.form.count({
        where: { tenantId: beta.id },
      });
      expect(formsAfter).toBe(formsBefore);
    });
  });
});
