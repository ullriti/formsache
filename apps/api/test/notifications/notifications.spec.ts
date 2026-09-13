import {
  MAIL_RECIPIENT_LIMIT,
  parseNotificationList,
  type Notification,
} from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FORM_NOT_FOUND_MESSAGE } from '../../src/forms/forms.service';
import {
  NOTIFICATION_NOT_FOUND_MESSAGE,
  unknownRecipientQuestionMessage,
} from '../../src/notifications/notifications.service';
import { MISSING_PERMISSION_MESSAGE } from '../../src/tenancy/group-permission.guard';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  apiPath,
  configureSystemMail,
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
 * The notification CRUD of the requirement, against real PostgreSQL.
 *
 * Written the way `CONTRIBUTING.md` asks of a rights or isolation rule: every
 * guarantee is asserted through the case that has to **fail**. Each permission
 * appears as a pair — without the flag 403, with it 2xx — because a suite of
 * only the allowed half stays green against a guard that refuses nobody, and
 * every tenant assertion is about an organisation reading something it must not.
 *
 * **Negative probes, measured while writing this file** (each rule removed,
 * suite run, rule restored — the counts below are what was observed):
 *
 * - removing `@RequirePermission('canManageFormSettings')` from all four routes
 *   turns „refuses all four routes to a member who may build but not
 *   configure" red and nothing else; swapping it for `'canBuild'` turns **both**
 *   halves of that pair red, which is what makes it a pair rather than two
 *   tests of the same thing;
 * - dropping the `row.formId !== formId` test in
 *   `NotificationsService.requireNotification` turns „edits nothing through the
 *   wrong form of the same organisation" red;
 * - unbinding the tenant in `ScopedFormDelegate.findById` (`findUnique` on the
 *   composite key → `findFirst` on the id alone) turns „answers a foreign form
 *   exactly as an unknown one" red — the case that must fail is an organisation reaching
 *   another organisation's form, and it does;
 * - widening `notificationTriggerInputSchema` to the full enum turns the two
 *   „Bei Zwischenspeichern" refusals red while „a `save` row written straight
 *   into the database is still listed" stays green — which is what makes that
 *   one a control rather than a repetition;
 * - dropping the recipient-question check turns the „refuses a question …"
 *   cases red, and with it the case below that relies on it to prove „no
 *   addressable question at all" (`unknownRecipientQuestionMessage`);
 *   reverting `addressesSubmitter` to a bare `request.toSubmitter` turns
 *   „switches the participant delivery on when a question is chosen" red — see
 *   that test's own note.
 *
 * **What is deliberately not here: sending.** No mail leaves this file. The
 * trigger at the submission is elsewhere, and so is the queue; this proves what is
 * stored, who may store it, and what the server refuses.
 */

const PASSWORD = 'test-password';

const PAGE = '019ff600-0000-7000-8000-0000000000a0';
const NAME_QUESTION = '019ff600-0000-7000-8000-000000000001';
const EMAIL_QUESTION = '019ff600-0000-7000-8000-000000000002';
const SECOND_EMAIL_QUESTION = '019ff600-0000-7000-8000-000000000003';
/** A syntactically valid id that no form in this suite ever carries. */
const ABSENT_QUESTION = '019ff600-0000-7000-8000-0000000000ff';

const questionBase = {
  hint: null,
  required: false,
  width: 'full' as const,
};

const nameQuestion = {
  ...questionBase,
  id: NAME_QUESTION,
  type: 'text',
  label: 'Name',
  minLength: null,
  maxLength: null,
  pattern: null,
};

const emailQuestion = {
  ...questionBase,
  id: EMAIL_QUESTION,
  type: 'email',
  label: 'E-Mail',
};

const secondEmailQuestion = {
  ...questionBase,
  id: SECOND_EMAIL_QUESTION,
  type: 'email',
  label: 'E-Mail der Aktive',
};

function withQuestions(questions: readonly unknown[]): unknown {
  return { pages: [{ id: PAGE, title: 'Seite 1', questions }] };
}

/**
 * The minimum a create has to say; everything else has a schema default.
 *
 * **`replyTo` is part of that minimum**, and deliberately so: it is required
 * and nullable *without* a default, because the route replaces the
 * whole document and an omitted key would otherwise clear a configured address
 * without saying it. `null` is the inheritance — „was die Organisation bzw. das System
 * vorgibt" — not an empty field.
 */
function notificationBody(overrides: Record<string, unknown> = {}): object {
  return {
    name: 'Bestätigung',
    subject: 'Anmeldung eingegangen',
    body: 'Danke, {{formularorganisation}}.',
    replyTo: null,
    ...overrides,
  };
}

interface NotificationBody {
  id: string;
  formId: string;
  name: string;
  triggers: string[];
  format: string;
  toSubmitter: boolean;
  recipients: { kind: string; address?: string; questionId?: string }[];
  subject: string;
  body: string;
  active: boolean;
}

describe('notifications', () => {
  let testApp: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaAdmin: string;
  let betaAdmin: string;
  /** Everything except `can_manage_settings` — the „darf nicht" half. */
  let builderOnly: string;
  /** Only `can_manage_settings` — the „darf" half, and not an admin. */
  let settingsOnly: string;
  /** Only the organisation-wide settings right — without effect here (ADR-0021). */
  let orgSettingsOnly: string;
  let database: TestDatabase | undefined;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'NOTA');
    beta = await createTenant(testApp.prisma, 'NOTB');

    const alphaUser = await createUser(testApp.prisma, {
      email: 'notif-alpha@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    const betaUser = await createUser(testApp.prisma, {
      email: 'notif-beta@example.org',
      password: PASSWORD,
      tenants: [beta],
    });
    alphaAdmin = await openSession(testApp, alphaUser.id, alpha.id);
    betaAdmin = await openSession(testApp, betaUser.id, beta.id);

    const builder = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'notif-builder@example.org',
      groupName: 'Bauen ohne Einstellungen',
      permissions: {
        canBuild: true,
        canViewResponses: true,
        canExport: true,
        canManageSettings: false,
        canManageFormSettings: false,
      },
    });
    const settings = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'notif-settings@example.org',
      groupName: 'Nur Formular-Einstellungen',
      permissions: { canManageFormSettings: true },
    });
    // ADR-0021: the **organisation-wide** settings right, and nothing else.
    // It opens the organisation's form defaults, the appearance, the sending
    // identity and SSO — and explicitly **not** the notifications of a form.
    const orgSettings = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'notif-orgsettings@example.org',
      groupName: 'Nur Organisationseinstellungen',
      permissions: { canManageSettings: true },
    });
    builderOnly = await openSession(testApp, builder.id, alpha.id);
    settingsOnly = await openSession(testApp, settings.id, alpha.id);
    orgSettingsOnly = await openSession(testApp, orgSettings.id, alpha.id);
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** A form with the questions given, created and saved through the API. */
  async function formWith(
    token: string,
    questions: readonly unknown[],
    title = 'Anmeldung',
  ): Promise<string> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(token))
      .send({ title });
    expect(created.status).toBe(201);
    const form = created.body as { id: string; revision: number };

    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(token))
      .send({
        title,
        definition: withQuestions(questions),
        revision: form.revision,
      });
    expect(saved.status).toBe(200);
    return form.id;
  }

  function listNotifications(token: string, formId: string): request.Test {
    return request(app().server)
      .get(apiPath(`/forms/${formId}/notifications`))
      .set('Cookie', cookieHeader(token));
  }

  function postNotification(
    token: string,
    formId: string,
    body: object,
  ): request.Test {
    return request(app().server)
      .post(apiPath(`/forms/${formId}/notifications`))
      .set(authedMutation(token))
      .send(body);
  }

  function putNotification(
    token: string,
    formId: string,
    notificationId: string,
    body: object,
  ): request.Test {
    return request(app().server)
      .put(apiPath(`/forms/${formId}/notifications/${notificationId}`))
      .set(authedMutation(token))
      .send(body);
  }

  function deleteNotification(
    token: string,
    formId: string,
    notificationId: string,
  ): request.Test {
    return request(app().server)
      .delete(apiPath(`/forms/${formId}/notifications/${notificationId}`))
      .set(authedMutation(token));
  }

  /** Creates one through the real route and returns it. */
  async function createNotification(
    token: string,
    formId: string,
    body: object = notificationBody(),
  ): Promise<NotificationBody> {
    const response = await postNotification(token, formId, body);
    expect(response.status).toBe(201);
    return response.body as NotificationBody;
  }

  describe('storing what a mail will say', () => {
    it('creates, lists, replaces and deletes one', async () => {
      const formId = await formWith(alphaAdmin, [nameQuestion, emailQuestion]);

      const created = await createNotification(
        alphaAdmin,
        formId,
        notificationBody({
          recipients: [{ kind: 'literal', address: 'buero@example.org' }],
        }),
      );
      expect(created.formId).toBe(formId);
      // The schema defaults, asserted rather than assumed: they are the values
      // an editor never sees and therefore never corrects.
      expect(created.triggers).toEqual(['submit']);
      expect(created.format).toBe('html');
      expect(created.toSubmitter).toBe(false);
      expect(created.active).toBe(true);

      const listed = await listNotifications(alphaAdmin, formId);
      expect(listed.status).toBe(200);
      expect(
        (listed.body as { notifications: NotificationBody[] }).notifications,
      ).toHaveLength(1);

      const replaced = await putNotification(
        alphaAdmin,
        formId,
        created.id,
        notificationBody({
          name: 'Bestätigung (neu)',
          subject: 'Neuer Betreff',
          body: 'Hallo {{frage:' + EMAIL_QUESTION + '}}',
          active: false,
        }),
      );
      expect(replaced.status).toBe(200);
      const after = replaced.body as NotificationBody;
      expect(after.name).toBe('Bestätigung (neu)');
      expect(after.active).toBe(false);
      // `PUT` means replacement: the recipient the create carried is gone
      // because the update did not name it, not kept because it was not
      // mentioned.
      expect(after.recipients).toEqual([]);

      const removed = await deleteNotification(alphaAdmin, formId, created.id);
      expect(removed.status).toBe(204);

      const empty = await listNotifications(alphaAdmin, formId);
      expect(
        (empty.body as { notifications: NotificationBody[] }).notifications,
      ).toEqual([]);
    });

    it('answers 404 for a form that does not exist, before touching the table', async () => {
      const response = await listNotifications(
        alphaAdmin,
        '019ff600-0000-7000-8000-00000000dead',
      );
      expect(response.status).toBe(404);
      expect((response.body as { message: string }).message).toBe(
        FORM_NOT_FOUND_MESSAGE,
      );
    });

    it('edits nothing through the wrong form of the same organisation', async () => {
      const one = await formWith(alphaAdmin, [emailQuestion], 'Formular eins');
      const other = await formWith(
        alphaAdmin,
        [emailQuestion],
        'Formular zwei',
      );
      const notification = await createNotification(alphaAdmin, one);

      // Same Organisation, same session, same permissions — and still the wrong door.
      // Two forms are not a security boundary, but editing a mail one is not
      // looking at is a defect of its own.
      const response = await putNotification(
        alphaAdmin,
        other,
        notification.id,
        notificationBody({ name: 'Fremd' }),
      );
      expect(response.status).toBe(404);
      expect((response.body as { message: string }).message).toBe(
        NOTIFICATION_NOT_FOUND_MESSAGE,
      );

      const unchanged = await app().prisma.notification.findUniqueOrThrow({
        where: { id: notification.id },
      });
      expect(unchanged.name).toBe('Bestätigung');
    });

    it('answers a malformed notification id like an unknown one', async () => {
      const formId = await formWith(alphaAdmin, [emailQuestion]);
      const response = await deleteNotification(
        alphaAdmin,
        formId,
        'nicht-einmal-eine-uuid',
      );
      // A 500 here would tell the sender their string reached PostgreSQL.
      expect(response.status).toBe(404);
    });
  });

  describe('„Bei Zwischenspeichern" is absent, not disabled', () => {
    it('refuses a create that asks for the draft trigger, and writes nothing', async () => {
      const formId = await formWith(alphaAdmin, [emailQuestion]);

      const response = await postNotification(
        alphaAdmin,
        formId,
        notificationBody({ triggers: ['save'] }),
      );
      expect(response.status).toBe(400);
      expect(
        (response.body as { issues: { path: string }[] }).issues.map(
          (issue) => issue.path,
        ),
      ).toContain('triggers.0');

      // The refusal is the server's, so nothing reached the table — a non-goal
      // enforced only in the editor is a non-goal until somebody uses curl.
      expect(await app().prisma.notification.count({ where: { formId } })).toBe(
        0,
      );
    });

    it('refuses an update that would switch an existing one to it', async () => {
      const formId = await formWith(alphaAdmin, [emailQuestion]);
      const created = await createNotification(alphaAdmin, formId);

      const response = await putNotification(
        alphaAdmin,
        formId,
        created.id,
        notificationBody({ triggers: ['save'] }),
      );
      expect(response.status).toBe(400);

      const stored = await app().prisma.notification.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(stored.triggers).toEqual(['submit']);
    });

    it('still lists a `save` row written straight into the database', async () => {
      const formId = await formWith(alphaAdmin, [emailQuestion]);
      // The very fixture the non-goal is proven with: the column can hold the
      // value (a later addition must be additive), the API cannot produce it. Whether such a
      // row is *sent* is a different suite's half; this is the API's.
      await app().prisma.notification.create({
        data: {
          tenantId: alpha.id,
          formId,
          name: 'Von Hand',
          triggers: ['save'],
          subject: 'Entwurf gespeichert',
          body: 'Text',
          recipients: [{ kind: 'literal', address: 'buero@example.org' }],
        },
      });

      const response = await listNotifications(alphaAdmin, formId);
      expect(response.status).toBe(200);
      const [listed] = (response.body as { notifications: NotificationBody[] })
        .notifications;
      // A read schema that refused it would turn a row the application
      // correctly ignores into a page nobody can open.
      expect(listed?.triggers).toEqual(['save']);
    });
  });

  describe('recipients are structured (Nr. 31)', () => {
    it('stores a literal address and a question reference side by side', async () => {
      const formId = await formWith(alphaAdmin, [
        nameQuestion,
        emailQuestion,
        secondEmailQuestion,
      ]);

      const created = await createNotification(
        alphaAdmin,
        formId,
        notificationBody({
          recipients: [
            { kind: 'literal', address: 'buero@example.org' },
            { kind: 'question', questionId: SECOND_EMAIL_QUESTION },
          ],
        }),
      );

      // The **id** is what is stored, never the caption — and the
      // second e-mail question, not the first, because a position in the form
      // is not an intention.
      expect(created.recipients).toEqual([
        { kind: 'literal', address: 'buero@example.org' },
        { kind: 'question', questionId: SECOND_EMAIL_QUESTION },
      ]);
    });

    it('refuses a question recipient the form does not have', async () => {
      const formId = await formWith(alphaAdmin, [nameQuestion, emailQuestion]);

      const response = await postNotification(
        alphaAdmin,
        formId,
        notificationBody({
          recipients: [{ kind: 'question', questionId: ABSENT_QUESTION }],
        }),
      );
      expect(response.status).toBe(422);
      // Names the id, so the reason can be acted on rather than guessed at.
      expect((response.body as { message: string }).message).toContain(
        ABSENT_QUESTION,
      );
      expect(await app().prisma.notification.count({ where: { formId } })).toBe(
        0,
      );
    });

    it('refuses a question that cannot supply an address', async () => {
      const formId = await formWith(alphaAdmin, [nameQuestion, emailQuestion]);

      const response = await postNotification(
        alphaAdmin,
        formId,
        notificationBody({
          // A free-text question can hold an address, a phone number or a joke.
          recipients: [{ kind: 'question', questionId: NAME_QUESTION }],
        }),
      );
      expect(response.status).toBe(422);
    });

    it('refuses an address that would smuggle a second recipient in', async () => {
      const formId = await formWith(alphaAdmin, [emailQuestion]);

      const response = await postNotification(
        alphaAdmin,
        formId,
        notificationBody({
          recipients: [
            {
              kind: 'literal',
              address: 'Max <evil@example.com>, ok@example.de',
            },
          ],
        }),
      );
      expect(response.status).toBe(400);
      expect(await app().prisma.notification.count({ where: { formId } })).toBe(
        0,
      );
    });

    it('refuses more than the twenty-recipient limit', async () => {
      const formId = await formWith(alphaAdmin, [emailQuestion]);
      const recipients = Array.from(
        { length: MAIL_RECIPIENT_LIMIT + 1 },
        (_unused, index) => ({
          kind: 'literal',
          address: `empfaenger-${String(index)}@example.org`,
        }),
      );

      const response = await postNotification(
        alphaAdmin,
        formId,
        notificationBody({ recipients }),
      );
      expect(response.status).toBe(400);
    });

    /**
     * The participant-delivery scenario the old `toSubmitter` flag guarded
     * („Das Formular hat keine E-Mail-Frage") now has no flag to check —
     * `addressesSubmitter` is derived from the recipients, so the only way to
     * ask for participant delivery is to name a question recipient. A form
     * with no addressable question at all refuses **any** question recipient,
     * for the same reason the ordinary „refuses a question that cannot supply
     * an address" case below does: the loop in `checkRecipients` never lets a
     * non-addressable id through. This case is that rule's edge — an
     * `addressable` set that is empty, not merely missing one id.
     */
    it('refuses a question recipient when the form has no addressable question at all', async () => {
      const formId = await formWith(alphaAdmin, [nameQuestion]);

      const response = await postNotification(
        alphaAdmin,
        formId,
        notificationBody({
          recipients: [{ kind: 'question', questionId: NAME_QUESTION }],
        }),
      );
      expect(response.status).toBe(422);
      expect((response.body as { message: string }).message).toBe(
        unknownRecipientQuestionMessage(NAME_QUESTION),
      );
      expect(await app().prisma.notification.count({ where: { formId } })).toBe(
        0,
      );
    });

    /**
     * **Picking the chip *is* switching the participant delivery on** .
     *
     * A recipient of kind `question` reads its address out of the answer, so it
     * is the participant's address by construction. As two independent switches
     * the two could disagree — chip set, flag cleared — and the effective
     * setting *Bestätigung an Teilnehmer senden*, which the requirement calls **the** switch,
     * then did not apply to that notification at all. Here the flag is the
     * consequence of the chip, so the stored row is self-consistent whichever
     * client wrote it.
     *
     * Derived rather than refused, deliberately: a 422 („bitte auch das Häkchen
     * setzen") would ask an editor to state twice what they said once, and would
     * make a correct client a precondition for a correct row.
     *
     * *Reproduction:* `toWrite`'s `toSubmitter: addressesSubmitter(request)`
     * hard-coded to `false` turns this case red; the enforcement is proven
     * separately in `test/public/submission-mail.spec.ts`, against a row
     * written straight into the database.
     */
    it('switches the participant delivery on when a question is chosen', async () => {
      const formId = await formWith(alphaAdmin, [nameQuestion, emailQuestion]);

      const created = await createNotification(
        alphaAdmin,
        formId,
        notificationBody({
          recipients: [{ kind: 'question', questionId: EMAIL_QUESTION }],
        }),
      );
      expect(created.toSubmitter).toBe(true);

      // Read back rather than only believed: the response is rendered from the
      // stored row, and it is the stored row the send path reads.
      const listed = await listNotifications(alphaAdmin, formId);
      expect(
        (listed.body as { notifications: NotificationBody[] }).notifications[0]
          ?.toSubmitter,
      ).toBe(true);

      // The control: a purely internal notification is untouched by the rule.
      const office = await createNotification(
        alphaAdmin,
        formId,
        notificationBody({
          name: 'An das Büro',
          recipients: [{ kind: 'literal', address: 'buero@example.org' }],
        }),
      );
      expect(office.toSubmitter).toBe(false);
    });
  });

  /**
   * **The *effective* reply address stands on the read document** (the
   * requirement).
   *
   * The point arose because `replyTo` alone does not answer the question: it
   * is the **topmost** of three levels, and `null` there means „es gilt, was
   * die Organisation bzw. das System vorgibt" — rows this route otherwise
   * never touches. Formerly a test mail was the only way to the effective
   * address.
   *
   * What is measured is therefore the **difference between the levels**: the
   * same notification, read three times, three times a different effective
   * value *and* a different origin, without the row itself changing. A case
   * that checks only one level would stay green if the route passed
   * `row.replyTo` through or hard-wired one level.
   *
   * **The origin is part of the promise.** Without it the field does not
   * answer „warum diese?" — and precisely that question produced the point.
   *
   * *Reproduction, measured (2026-08-06)* — the one of the requirement: in
   * `toView` build the field from the notification **alone**
   * (`{ address: row.replyTo, origin: row.replyTo === null ? null :
   * 'notification' }`) instead of from `effectiveReplyTo`. Result: **4 red, 2
   * green** of the six cases of this block. Red turn the four in which a
   * *different* level applies than the topmost one; green stay „die
   * Benachrichtigung hat eine eigene" and „keine Ebene hat eine" — there the
   * shortcut happens to be right. Precisely for that reason the case „ohne
   * eigene Adresse" comes first: it is the only one the requirement demands
   * as evidence at all, and the two green ones show why it alone is not
   * enough either.
   */
  describe('die wirksame Antwortadresse', () => {
    const NOTIFICATION_LEVEL = 'benachrichtigung@notif.example.org';
    const TENANT_LEVEL = 'organisation@notif.example.org';
    const SYSTEM_LEVEL = 'system@notif.example.org';

    let formId: string;
    let notificationId: string;

    /** Setting the two lower levels — every case establishes them in full. */
    async function setLowerLevels(levels: {
      tenant: string | null;
      system: string | null;
    }): Promise<void> {
      await app().prisma.tenant.update({
        where: { id: alpha.id },
        data: { replyTo: levels.tenant },
      });
      await configureSystemMail(app(), { replyTo: levels.system });
    }

    /** The read document of this one notification, **strictly parsed**. */
    async function readDocument(): Promise<Notification> {
      const response = await listNotifications(alphaAdmin, formId);
      expect(response.status).toBe(200);
      // `parseNotificationList` and not a cast: `notificationSchema` is
      // strict, so it also shows here when the server does not send the field
      // at all — an assertion on `undefined === undefined` would otherwise be
      // green.
      const parsed = parseNotificationList(response.body);
      const row = parsed.notifications.find(
        (candidate) => candidate.id === notificationId,
      );
      if (row === undefined) {
        throw new Error(
          'Die Benachrichtigung steht nicht in der Liste — der Fall misst nichts.',
        );
      }
      return row;
    }

    beforeAll(async () => {
      formId = await formWith(
        alphaAdmin,
        [nameQuestion, emailQuestion],
        'Antwortadresse',
      );
      const created = await createNotification(alphaAdmin, formId);
      notificationId = created.id;
    });

    afterAll(async () => {
      // The levels belong to no other case of this file — reset, so that the
      // order of the blocks means nothing. BETA belongs to that: the last case
      // sets an address there too.
      await setLowerLevels({ tenant: null, system: null });
      await app().prisma.tenant.update({
        where: { id: beta.id },
        data: { replyTo: null },
      });
    });

    /**
     * The evidence of the requirement, first half. It turns red from the
     * reproduction at the head of the block — the row itself carries `null`,
     * the effective address stands one level lower.
     */
    it('names the organisation’s address and its origin when the notification has none', async () => {
      await setLowerLevels({ tenant: TENANT_LEVEL, system: SYSTEM_LEVEL });

      const row = await readDocument();
      // The row itself is unchanged empty — that is the whole point: the
      // effective value is not the stored field.
      expect(row.replyTo).toBe(null);
      expect(row.effectiveReplyTo).toEqual({
        address: TENANT_LEVEL,
        origin: 'tenant',
      });
    });

    /**
     * **The third read path: `POST`** (review of package 0-A).
     *
     * `create` returns the read document of the row just created, and the
     * editor displays exactly that instead of fetching the list again.
     * Without this case a `toView(row, [])` in `NotificationsService.create`
     * would turn **no** test red — the new notification reported „keine",
     * although the organisation has an address.
     */
    it('names the effective address on the freshly created row, too', async () => {
      await setLowerLevels({ tenant: TENANT_LEVEL, system: SYSTEM_LEVEL });

      const created = await postNotification(
        alphaAdmin,
        formId,
        notificationBody({ name: 'Zweite' }),
      );
      expect(created.status).toBe(201);
      expect(
        (created.body as { effectiveReplyTo: unknown }).effectiveReplyTo,
      ).toEqual({ address: TENANT_LEVEL, origin: 'tenant' });
    });

    /**
     * **The inherited levels stand raw on the list** (the requirement, a review finding of the review) — for the question that `effectiveReplyTo` per row
     * cannot answer: what applies for a notification that does not exist yet,
     * and what applies for the draft in the field?
     *
     * What is measured is **the order**: it *is* the precedence
     * (`effectiveReplyTo` in `@formsache/shared` — `origin` only labels). A
     * swapped list would let the editor put the system default before that of
     * the organisation, and the row would then claim a different address than
     * the one that goes out.
     */
    it('carries the two inherited levels, in the order that decides', async () => {
      await setLowerLevels({ tenant: TENANT_LEVEL, system: SYSTEM_LEVEL });

      const response = await listNotifications(alphaAdmin, formId);
      expect(response.status).toBe(200);
      expect(parseNotificationList(response.body).inheritedReplyTo).toEqual([
        { origin: 'tenant', value: TENANT_LEVEL },
        { origin: 'system', value: SYSTEM_LEVEL },
      ]);
    });

    /**
     * **`can_manage_settings` alone suffices for the effective address — and
     * that is decided, not forgotten** (review of package 0-A, 2026-08-06).
     *
     * The reasoning stands at
     * `NotificationsService.inheritedReplyTo`; here stands its measurement,
     * and in **both** halves: the same session that gets the address here with
     * 200 including its origin is refused at `GET /tenant/reply-to` — the
     * route that edits the *same* column — with **403**. Only that together
     * proves that the asymmetry is intended: a case that checked only the 200
     * would also be green if somebody at some point removed the second
     * permission from the tenant route.
     *
     * *Reproduction:* pull `list` onto
     * `@RequireAllPermissions('canManageFormSettings','canViewResponses')` —
     * this case turns red at the first assertion (403 instead of 200), and
     * with it „opens all four to a member who holds only that one flag".
     */
    it('gives a settings-only member the effective address, unlike the tenant route', async () => {
      await setLowerLevels({ tenant: TENANT_LEVEL, system: SYSTEM_LEVEL });

      const listed = await listNotifications(settingsOnly, formId);
      expect(listed.status).toBe(200);
      const parsed = parseNotificationList(listed.body);
      const row = parsed.notifications.find(
        (candidate) => candidate.id === notificationId,
      );
      expect(row?.effectiveReplyTo).toEqual({
        address: TENANT_LEVEL,
        origin: 'tenant',
      });

      // The other half: the same session, the same column, the second gate.
      const tenantRoute = await request(app().server)
        .get(apiPath('/tenant/reply-to'))
        .set('Cookie', cookieHeader(settingsOnly));
      expect(tenantRoute.status).toBe(403);
      expect((tenantRoute.body as { message: string }).message).toBe(
        MISSING_PERMISSION_MESSAGE,
      );
    });

    /**
     * The same row, one level fewer — the second half of the evidence. It is
     * no duplicate of the case above: that one would stay green if the chain
     * stopped at the organisation's level instead of falling through.
     */
    it('falls through to the system default once the organisation’s is gone', async () => {
      await setLowerLevels({ tenant: null, system: SYSTEM_LEVEL });

      expect((await readDocument()).effectiveReplyTo).toEqual({
        address: SYSTEM_LEVEL,
        origin: 'system',
      });
    });

    /** The topmost level wins, and the origin says so. */
    it('names the notification’s own address when it has one', async () => {
      await setLowerLevels({ tenant: TENANT_LEVEL, system: SYSTEM_LEVEL });
      const replaced = await putNotification(
        alphaAdmin,
        formId,
        notificationId,
        notificationBody({ replyTo: NOTIFICATION_LEVEL }),
      );
      expect(replaced.status).toBe(200);

      // The answer of the `PUT` carries it too — not only the list: after
      // saving, the editor shows the document the route returns.
      expect(
        (replaced.body as { effectiveReplyTo: unknown }).effectiveReplyTo,
      ).toEqual({ address: NOTIFICATION_LEVEL, origin: 'notification' });
      expect((await readDocument()).effectiveReplyTo).toEqual({
        address: NOTIFICATION_LEVEL,
        origin: 'notification',
      });
    });

    /**
     * **The fourth state: none.** It is a statement — the mail goes out
     * without the header (`effectiveReplyTo` in `@formsache/shared` gives the
     * reason why that becomes neither a guessed address nor a refusal) — and
     * therefore has to arrive, instead of quietly looking like „unbekannt".
     */
    it('says „keine" when no level has one at all', async () => {
      await setLowerLevels({ tenant: null, system: null });
      expect(
        (
          await putNotification(
            alphaAdmin,
            formId,
            notificationId,
            notificationBody({ replyTo: null }),
          )
        ).status,
      ).toBe(200);

      expect((await readDocument()).effectiveReplyTo).toEqual({
        address: null,
        origin: null,
      });
    });

    /**
     * **A stored value that is not an address falls through — and the origin
     * names the *winning* level, not the one that was set.**
     *
     * The value reaches the column past the API (`replyToAddressSchema` would
     * refuse it with 400), the way a hand-written row or an old migration
     * would do it. This is the case at which the obvious shortcut „Feld
     * gesetzt ⇒ `notification`" is exposed: the address alone would not give
     * it away, the origin does.
     */
    it('reports the level that won, not the one that was merely set', async () => {
      await setLowerLevels({ tenant: TENANT_LEVEL, system: SYSTEM_LEVEL });
      await app().prisma.notification.update({
        where: { id: notificationId },
        data: { replyTo: 'Dachorganisation <bt@notif.example.org>' },
      });

      const row = await readDocument();
      expect(row.replyTo).toBe('Dachorganisation <bt@notif.example.org>');
      expect(row.effectiveReplyTo).toEqual({
        address: TENANT_LEVEL,
        origin: 'tenant',
      });
    });

    /**
     * **The organisation's level comes from the session, not from the form.**
     *
     * BETA reads its own notification and gets the default of *its*
     * organisation — the same system level, a different organisation, a
     * different effective value. An `inheritedReplyTo` that read the
     * organisation from any place other than `scope` (or took the first
     * `tenant` row) turns red here.
     */
    it('reads the organisation of the session, not of some other organisation', async () => {
      await setLowerLevels({ tenant: TENANT_LEVEL, system: SYSTEM_LEVEL });
      const betaReplyTo = 'organisation@beta-notif.example.org';
      await app().prisma.tenant.update({
        where: { id: beta.id },
        data: { replyTo: betaReplyTo },
      });

      const betaForm = await formWith(
        betaAdmin,
        [nameQuestion],
        'BETA-Formular',
      );
      await createNotification(betaAdmin, betaForm);

      const response = await listNotifications(betaAdmin, betaForm);
      expect(response.status).toBe(200);
      const [row] = parseNotificationList(response.body).notifications;
      expect(row?.effectiveReplyTo).toEqual({
        address: betaReplyTo,
        origin: 'tenant',
      });
    });
  });

  describe('group permissions — `can_manage_form_settings`, and only that', () => {
    it('refuses all four routes to a member who may build but not configure', async () => {
      const formId = await formWith(alphaAdmin, [emailQuestion]);
      const existing = await createNotification(alphaAdmin, formId);

      const read = await listNotifications(builderOnly, formId);
      expect(read.status).toBe(403);
      expect((read.body as { message: string }).message).toBe(
        MISSING_PERMISSION_MESSAGE,
      );

      const created = await postNotification(
        builderOnly,
        formId,
        notificationBody({ name: 'Heimlich' }),
      );
      expect(created.status).toBe(403);

      const replaced = await putNotification(
        builderOnly,
        formId,
        existing.id,
        notificationBody({ name: 'Heimlich' }),
      );
      expect(replaced.status).toBe(403);

      const removed = await deleteNotification(
        builderOnly,
        formId,
        existing.id,
      );
      expect(removed.status).toBe(403);

      // Nothing of the four got through — 403 is the guard's answer, and the
      // table is where that is checked rather than believed.
      const stored = await app().prisma.notification.findMany({
        where: { formId },
      });
      expect(stored).toHaveLength(1);
      expect(stored[0]?.name).toBe('Bestätigung');
    });

    /**
     * ADR-0021, the forbidden case: the **organisation-wide**
     * `can_manage_settings` does not open the notifications of a form.
     * Without this case the new permission would only be a second name for the
     * old one, and nobody would notice if a route slipped back onto the wide
     * permission.
     */
    it('refuses all four routes to a member holding only the organisation-wide settings right', async () => {
      const formId = await formWith(alphaAdmin, [emailQuestion]);
      const existing = await createNotification(alphaAdmin, formId);

      const read = await listNotifications(orgSettingsOnly, formId);
      expect(read.status).toBe(403);
      expect((read.body as { message: string }).message).toBe(
        MISSING_PERMISSION_MESSAGE,
      );

      expect(
        (
          await postNotification(
            orgSettingsOnly,
            formId,
            notificationBody({ name: 'Heimlich' }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await putNotification(
            orgSettingsOnly,
            formId,
            existing.id,
            notificationBody({ name: 'Heimlich' }),
          )
        ).status,
      ).toBe(403);
      expect(
        (await deleteNotification(orgSettingsOnly, formId, existing.id)).status,
      ).toBe(403);

      // As with the building group: looked up instead of believed.
      const stored = await app().prisma.notification.findMany({
        where: { formId },
      });
      expect(stored).toHaveLength(1);
      expect(stored[0]?.name).toBe('Bestätigung');
    });

    it('opens all four to a member who holds only that one flag', async () => {
      const formId = await formWith(alphaAdmin, [emailQuestion]);

      const created = await postNotification(
        settingsOnly,
        formId,
        notificationBody(),
      );
      expect(created.status).toBe(201);
      const notification = created.body as NotificationBody;

      expect((await listNotifications(settingsOnly, formId)).status).toBe(200);
      expect(
        (
          await putNotification(
            settingsOnly,
            formId,
            notification.id,
            notificationBody({ name: 'Geändert' }),
          )
        ).status,
      ).toBe(200);
      expect(
        (await deleteNotification(settingsOnly, formId, notification.id))
          .status,
      ).toBe(204);
    });
  });

  describe('the tenant boundary', () => {
    it('answers a foreign form exactly as an unknown one, on every route', async () => {
      const formId = await formWith(alphaAdmin, [emailQuestion]);
      const notification = await createNotification(
        alphaAdmin,
        formId,
        notificationBody({
          recipients: [{ kind: 'literal', address: 'geheim@nota.example' }],
        }),
      );

      const listed = await listNotifications(betaAdmin, formId);
      expect(listed.status).toBe(404);
      expect((listed.body as { message: string }).message).toBe(
        FORM_NOT_FOUND_MESSAGE,
      );
      // The whole payload, not the visible fields: an address that leaked into
      // an error detail would be just as leaked.
      expect(JSON.stringify(listed.body)).not.toContain('geheim@nota.example');

      expect(
        (await postNotification(betaAdmin, formId, notificationBody())).status,
      ).toBe(404);
      expect(
        (
          await putNotification(
            betaAdmin,
            formId,
            notification.id,
            notificationBody({ name: 'Übernommen' }),
          )
        ).status,
      ).toBe(404);
      expect(
        (await deleteNotification(betaAdmin, formId, notification.id)).status,
      ).toBe(404);

      const stored = await app().prisma.notification.findUniqueOrThrow({
        where: { id: notification.id },
      });
      expect(stored.name).toBe('Bestätigung');
      expect(stored.tenantId).toBe(alpha.id);
    });
  });

  /*
   * **A test that was written here and deleted again**, because it could not
   * fail: „BETA lists its own form and sees none of ALPHA's notifications".
   * The two forms have different ids, so that list stays empty even with the
   * tenant binding removed from `findManyOfForm` — measured, not assumed. The
   * boundary that *can* break is the one above (BETA reaching ALPHA's form) and
   * the delegate itself, which `test/tenancy/mail-scope.spec.ts` covers case by
   * forbidden case. A green test that proves nothing is worse than no test,
   * because it is counted.
   */
});
