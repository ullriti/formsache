import { parseMailLogList } from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE } from '../../src/mail-log/mail-log.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
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
 * The **fourth link on the mail log** (review finding): a person
 * locked out of a form reaches neither its log lines nor the rendered mails
 * behind them.
 *
 * The hole this file closes was the export hole a second time. `mail-log/**`
 * hung behind `SessionGuard, TenantScopeGuard, GroupPermissionGuard` and
 * **not** `FormRestrictionGuard`, so somebody with a `form_permission` row
 * saying "no access to form X" still read X's correspondence through
 * `GET /api/mail-log?formId=X` — and through `GET /api/mail-log/:id` the whole
 * rendered body, i.e. every answer value a template put into it.
 *
 * ## Why the person under test looks the way they do
 *
 * They hold **`can_view_responses` *and* `can_manage_settings`** — both flags
 * these routes require — and they are **not** an
 * administrator. Any weaker fixture proves nothing: a member missing a flag is
 * refused by the *third* link, and an administrator is not restrictable at all
 * , so either would go green against a chain with no
 * fourth link in it.
 *
 * ## Both halves of a restriction, and the second one is why this file grew
 *
 * A `form_permission` row says two things — "locked" (`access_revoked`) and
 * "capped to this group" (`capped_group_id`) — and the first version of
 * this file only ever wrote the first. The mail log matched: it asked
 * `accessRevoked === true` and nothing else, so somebody capped on form X to a
 * group **without** `can_view_responses` still read X's rendered mail here,
 * answer values and all, and could hand the line back to the worker — while
 * the very same restriction answered 403 on `?formId=X` (review finding).
 *
 * The capped person is therefore built so that **only the fourth link can
 * refuse them**: they hold `can_view_responses` in their own group, so the
 * third link lets them through, and the cap is what takes it away on this one
 * form. A person merely missing the flag would be refused by the third link
 * and would prove nothing at all.
 *
 * ## What each case is measured against
 *
 * | Rule removed | Case that goes red |
 * |---|---|
 * | `hiddenForms` in `ScopedMailLogDelegate.where()` | the list cases (entries **and** counters), both halves |
 * | `requireUnrestricted` in `MailLogService.detail` | the detail cases |
 * | `requireUnrestricted` in `MailLogService.retry` | the retry cases |
 * | `FormRestriction.verdictFor`'s cap branch (`return 'open'` after the revocation check) | every "capped" case, and no "locked" one |
 * | `@FormIdInQuery('formId')` on the list route | the prefilter cases (`?formId=` no longer evaluated) |
 *
 * The rows the restriction must **not** touch are asserted in the same cases,
 * because a filter that hides everything would pass a suite that only checks
 * that the locked form is gone: the second form's lines stay, and so does a
 * line whose form was deleted (`form_id IS NULL` — it belongs to no form, so no
 * restriction can point at it).
 */

const SETUP_TIMEOUT_MS = 180_000;
const LOCKED_SUBJECT = 'Anmeldung Jahrestagung bestaetigt';
const LOCKED_RECIPIENT = 'gesperrt@alpha.example';
const LOCKED_BODY_ANSWER = 'Fuchsmajor';
const OPEN_SUBJECT = 'Semesterrueckmeldung eingegangen';
const OPEN_RECIPIENT = 'offen@alpha.example';
const ORPHAN_SUBJECT = 'Zeile ohne Formular';
const ORPHAN_RECIPIENT = 'verwaist@alpha.example';

describe('per-form restrictions on the Versandprotokoll ', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let app: TestApp;
  let prisma: PrismaService;

  let alpha: TenantFixture;

  /** Both flags, no admin group, restrictable — see the file comment. */
  let member: { id: string; token: string };
  /** An administrator of the same organisation: the control the guard must ignore. */
  let admin: { id: string; token: string };
  /**
   * The group a cap lowers **to**: keeps `can_manage_settings`, drops
   * `can_view_responses`. Ranked below the member's own group, so it is a cap
   * the write route would also accept — the row is planted raw all the same.
   */
  let blindGroupId: string;

  let lockedFormId: string;
  let openFormId: string;

  /** One line per form, plus one whose form was deleted (`SetNull`). */
  let lockedLineId: string;
  let openLineId: string;
  let orphanLineId: string;

  /** Writes a restriction row the way no route would — straight to SQL. */
  async function restrict(
    formId: string,
    userId: string,
    options: { accessRevoked: boolean; cappedGroupId: string | null },
  ): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "form_permission"
         ("id", "tenant_id", "form_id", "user_id", "access_revoked",
          "capped_group_id", "created_at", "updated_at")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::boolean,
               $5::uuid, now(), now())`,
      alpha.id,
      formId,
      userId,
      options.accessRevoked,
      options.cappedGroupId,
    );
  }

  /** „Zugriff gesperrt" on one form. */
  function revokeAccess(formId: string, userId: string): Promise<void> {
    return restrict(formId, userId, {
      accessRevoked: true,
      cappedGroupId: null,
    });
  }

  /**
   * "On this one page only *blind*" — capped to a group that keeps
   * `can_manage_settings` and drops `can_view_responses`, which is exactly one
   * of the two flags these routes require.
   */
  function capToBlind(formId: string, userId: string): Promise<void> {
    return restrict(formId, userId, {
      accessRevoked: false,
      cappedGroupId: blindGroupId,
    });
  }

  function get(token: string, query = ''): request.Test {
    return request(app.server)
      .get(apiPath(`/mail-log${query}`))
      .set('Cookie', cookieHeader(token));
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
    app = testApp;
    prisma = testApp.prisma;

    alpha = await createTenant(prisma, 'ALPHA');

    const both = await createRestrictedMember(prisma, alpha, {
      email: 'protokoll@alpha.example',
      groupName: 'protokoll',
      permissions: { canManageFormSettings: true, canViewResponses: true },
    });
    member = { id: both.id, token: await openSession(app, both.id, alpha.id) };

    const blind = await prisma.group.create({
      data: {
        tenantId: alpha.id,
        name: 'protokoll-blind',
        color: '#212226',
        rank: 10,
        isSystem: false,
        // The pair is the whole point: one of the two flags the routes need
        // stays, the other goes. A cap holding neither would be refused for
        // the wrong reason, and one holding both would refuse nothing.
        canManageSettings: true,
        canManageFormSettings: true,
        canViewResponses: false,
      },
    });
    blindGroupId = blind.id;

    const adminUser = await createUser(prisma, {
      email: 'admin@alpha.example',
      password: 'test-password',
      tenants: [alpha],
    });
    admin = {
      id: adminUser.id,
      token: await openSession(app, adminUser.id, alpha.id),
    };

    const locked = await prisma.form.create({
      data: {
        tenantId: alpha.id,
        title: 'Anmeldung Jahrestagung',
        draftSchema: { pages: [] },
        publicSlug: 'slug-alpha-gesperrt-mail-log',
      },
    });
    lockedFormId = locked.id;

    const open = await prisma.form.create({
      data: {
        tenantId: alpha.id,
        title: 'Bestandsmeldung',
        draftSchema: { pages: [] },
        publicSlug: 'slug-alpha-offen-mail-log',
      },
    });
    openFormId = open.id;

    const lockedLine = await prisma.mailLog.create({
      data: {
        tenantId: alpha.id,
        formId: lockedFormId,
        recipient: LOCKED_RECIPIENT,
        subject: LOCKED_SUBJECT,
        status: 'failed',
        attempts: 5,
        lastError: 'ALPHA 550 unbekannter Empfaenger',
        // The body is the reason this whole file exists: a template may put
        // `{{antworten}}` into it, so a rendered mail carries answer values.
        bodyText: `Danke. Deine Angabe: ${LOCKED_BODY_ANSWER}`,
        bodyHtml: `<p>Danke. Deine Angabe: ${LOCKED_BODY_ANSWER}</p>`,
      },
    });
    lockedLineId = lockedLine.id;

    const openLine = await prisma.mailLog.create({
      data: {
        tenantId: alpha.id,
        formId: openFormId,
        recipient: OPEN_RECIPIENT,
        subject: OPEN_SUBJECT,
        status: 'failed',
        attempts: 5,
        bodyText: 'Danke.',
        bodyHtml: '<p>Danke.</p>',
      },
    });
    openLineId = openLine.id;

    // `mail_log.form_id` is `SetNull`, so a line outlives its form. It belongs
    // to no form, therefore no restriction can point at it — see the `where()`
    // comment in `tenant-scope.ts` for why that is a decision and not a detail.
    const orphanLine = await prisma.mailLog.create({
      data: {
        tenantId: alpha.id,
        formId: null,
        recipient: ORPHAN_RECIPIENT,
        subject: ORPHAN_SUBJECT,
        status: 'failed',
        attempts: 5,
      },
    });
    orphanLineId = orphanLine.id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await database?.release();
  }, SETUP_TIMEOUT_MS);

  beforeEach(async () => {
    // Every case states its own restriction; a row surviving into the next test
    // would make a green run mean "something or other was locked".
    await prisma.formPermission.deleteMany({});
  });

  describe('the list is narrowed in the query, not afterwards', () => {
    it('carries no trace of a locked form anywhere in the payload', async () => {
      await revokeAccess(lockedFormId, member.id);

      const response = await get(member.token);
      expect(response.status).toBe(200);

      // The **whole** payload, not the fields a mapper happens to fill: a
      // restriction applied after the load would leave the row here — loaded,
      // serialised, merely unrendered by a client. That is a display matter.
      const payload = JSON.stringify(response.body);
      expect(payload).not.toContain(lockedLineId);
      expect(payload).not.toContain(LOCKED_RECIPIENT);
      expect(payload).not.toContain(LOCKED_SUBJECT);
      expect(payload).not.toContain(lockedFormId);

      // …and the rows that must stay are still there, so "hidden" is not
      // "empty": the other form's line, and the line without a form.
      expect(payload).toContain(OPEN_RECIPIENT);
      expect(payload).toContain(ORPHAN_RECIPIENT);

      // The control: without the row the same session sees the locked line.
      await prisma.formPermission.deleteMany({});
      const unlocked = await get(member.token);
      expect(JSON.stringify(unlocked.body)).toContain(LOCKED_RECIPIENT);
    });

    /**
     * The KPI tiles are counted in the database over the same condition. Tiles
     * that counted the whole organisation would report „3 fehlgeschlagen" above a table
     * showing two — and the number itself is a statement about a form this
     * person may not see.
     */
    it('counts the tiles over the same condition', async () => {
      const before = parseMailLogList((await get(member.token)).body);
      expect(before.counts.failed).toBe(3);

      await revokeAccess(lockedFormId, member.id);

      const after = parseMailLogList((await get(member.token)).body);
      expect(after.counts.failed).toBe(2);
      expect(after.counts.total).toBe(2);
      expect(after.entries).toHaveLength(2);
    });

    /**
     * The prefilter of the specification, arriving as a **query** parameter
     * — the shape the guard used to be unable to see at all, because it only
     * ever looked in `request.params`.
     *
     * The name says what is asserted (review finding): this is **not** "an
     * empty log", it is the form's own 404 — the same answer every other route
     * gives this person for this form. An empty 200 was the
     * alternative and was decided against, because it would make the fourth
     * link invisible on the one route that addresses a form here (see the
     * comment on the route in `mail-log.controller.ts`).
     */
    it('answers the prefilter on a locked form with that form’s own 404', async () => {
      await revokeAccess(lockedFormId, member.id);

      const response = await get(member.token, `?formId=${lockedFormId}`);
      expect(response.status).toBe(404);
      expect(response.text).not.toContain(LOCKED_RECIPIENT);
      expect(response.text).not.toContain(LOCKED_SUBJECT);

      // The control: the form they are not locked out of still answers.
      const open = await get(member.token, `?formId=${openFormId}`);
      expect(open.status).toBe(200);
      expect(JSON.stringify(open.body)).toContain(OPEN_RECIPIENT);
    });

    /**
     * **The capped half of the same prefilter.** A cap does not hide a form —
     * it answers 403, "you may not do *that* here" — and that is the one place
     * in this file where the two halves are told apart by status code rather
     * than only by which rows come back.
     */
    it('answers the prefilter on a capped form with 403, and no lines', async () => {
      await capToBlind(lockedFormId, member.id);

      const response = await get(member.token, `?formId=${lockedFormId}`);
      expect(response.status).toBe(403);
      expect(response.text).not.toContain(LOCKED_RECIPIENT);
      expect(response.text).not.toContain(LOCKED_SUBJECT);

      // The control: the same cap on a *different* form leaves this one alone.
      await prisma.formPermission.deleteMany({});
      await capToBlind(openFormId, member.id);
      const untouched = await get(member.token, `?formId=${lockedFormId}`);
      expect(untouched.status).toBe(200);
      expect(JSON.stringify(untouched.body)).toContain(LOCKED_RECIPIENT);
    });

    /**
     * The list without a prefilter, where a guard can refuse nothing and the
     * cap has to reach the `where` — the half `ScopedMailLogDelegate` was
     * missing entirely (review finding): it filtered on
     * `access_revoked` alone, so a capped form's subjects and recipients came
     * back in full.
     */
    it('carries no trace of a capped form anywhere in the payload', async () => {
      await capToBlind(lockedFormId, member.id);

      const response = await get(member.token);
      expect(response.status).toBe(200);

      const payload = JSON.stringify(response.body);
      expect(payload).not.toContain(lockedLineId);
      expect(payload).not.toContain(LOCKED_RECIPIENT);
      expect(payload).not.toContain(LOCKED_SUBJECT);
      expect(payload).not.toContain(lockedFormId);

      // …and the rows a cap on *this* form says nothing about are still here.
      expect(payload).toContain(OPEN_RECIPIENT);
      expect(payload).toContain(ORPHAN_RECIPIENT);

      // The counters agree with the table they sit above — tiles counted over
      // the whole organisation would report a line this person may not see.
      const counted = parseMailLogList(response.body);
      expect(counted.counts.failed).toBe(2);
      expect(counted.counts.total).toBe(2);

      // The control: without the row the same session sees the capped line.
      await prisma.formPermission.deleteMany({});
      const unlocked = await get(member.token);
      expect(JSON.stringify(unlocked.body)).toContain(LOCKED_RECIPIENT);
    });

    /**
     * …and a cap that keeps **both** required flags hides nothing. Without
     * this, "hidden" could just as well mean "any cap at all hides
     * everything", which is not what a cap says and would take the
     * mail log away from every capped person.
     */
    it('leaves the lines alone when the cap keeps what the route needs', async () => {
      const keeps = await prisma.group.create({
        data: {
          tenantId: alpha.id,
          name: `protokoll-behaelt-${String(Date.now())}`,
          color: '#212226',
          rank: 15,
          isSystem: false,
          canManageSettings: true,
          canManageFormSettings: true,
          canViewResponses: true,
          // Takes something away the mail log does not ask for.
          canExport: false,
        },
      });
      await restrict(lockedFormId, member.id, {
        accessRevoked: false,
        cappedGroupId: keeps.id,
      });

      const response = await get(member.token);
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).toContain(LOCKED_RECIPIENT);

      const prefiltered = await get(member.token, `?formId=${lockedFormId}`);
      expect(prefiltered.status).toBe(200);
    });

    /** An administrator is not restrictable — the row is ignored, not honoured. */
    it('ignores a restriction planted on an administrator', async () => {
      await revokeAccess(lockedFormId, admin.id);

      const response = await get(admin.token);
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).toContain(LOCKED_RECIPIENT);
    });
  });

  describe('the detail route', () => {
    /**
     * `:id` here is a **log line**, not a form, so the guard has nothing to
     * read off the request — the check lives in `MailLogService.detail`
     * against `mail_log.form_id`. What it must produce is the 404 an unknown id
     * produces, byte for byte: anything else turns the id into an oracle over
     * another form's correspondence (the evidence).
     */
    it('answers a locked line exactly as it answers an unknown id', async () => {
      await revokeAccess(lockedFormId, member.id);

      const unknown = await request(app.server)
        .get(apiPath('/mail-log/01919c3f-0000-7000-8000-000000000000'))
        .set('Cookie', cookieHeader(member.token));
      const locked = await request(app.server)
        .get(apiPath(`/mail-log/${lockedLineId}`))
        .set('Cookie', cookieHeader(member.token));

      expect(locked.status).toBe(404);
      expect(locked.status).toBe(unknown.status);
      expect(locked.text).toBe(unknown.text);
      expect(locked.text).toContain(MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE);
      // The payload of the refusal carries nothing of the mail either — this
      // route is the one that renders the body, answers included.
      expect(locked.text).not.toContain(LOCKED_BODY_ANSWER);
      expect(locked.text).not.toContain(LOCKED_RECIPIENT);

      // The controls: the other form's line and the line without a form are
      // untouched, and without the restriction the locked one opens.
      for (const id of [openLineId, orphanLineId]) {
        const allowed = await request(app.server)
          .get(apiPath(`/mail-log/${id}`))
          .set('Cookie', cookieHeader(member.token));
        expect(allowed.status).toBe(200);
      }

      await prisma.formPermission.deleteMany({});
      const unlocked = await request(app.server)
        .get(apiPath(`/mail-log/${lockedLineId}`))
        .set('Cookie', cookieHeader(member.token));
      expect(unlocked.status).toBe(200);
      expect(unlocked.text).toContain(LOCKED_BODY_ANSWER);
    });

    /**
     * **The hole this route actually had** (review finding):
     * `requireUnrestricted` asked `accessRevoked === true` and nothing else, so
     * the case above was green while a *cap* let the whole rendered mail
     * through — the answer values a template put into `{{antworten}}`, to
     * somebody the very same restriction refuses on `?formId=X`.
     *
     * The answer is the plain 404 here and not the 403 the prefilter gives,
     * and that difference is decided: `:id` is a **log line**, so a 403 would
     * confirm that a line with this id exists and belongs to a form this
     * person is restricted on (the evidence). On the
     * prefilter the caller named the form themselves and already knows it.
     */
    it('answers a capped line exactly as it answers an unknown id', async () => {
      await capToBlind(lockedFormId, member.id);

      const unknown = await request(app.server)
        .get(apiPath('/mail-log/01919c3f-0000-7000-8000-000000000000'))
        .set('Cookie', cookieHeader(member.token));
      const capped = await request(app.server)
        .get(apiPath(`/mail-log/${lockedLineId}`))
        .set('Cookie', cookieHeader(member.token));

      expect(capped.status).toBe(404);
      expect(capped.status).toBe(unknown.status);
      expect(capped.text).toBe(unknown.text);
      // The body is what this route renders, and it is the whole reason the
      // cap has to bite here: no answer value travelled in the refusal.
      expect(capped.text).not.toContain(LOCKED_BODY_ANSWER);
      expect(capped.text).not.toContain(LOCKED_RECIPIENT);

      // The controls: the other form's line, the line without a form, and the
      // same line once the cap is gone.
      for (const id of [openLineId, orphanLineId]) {
        const allowed = await request(app.server)
          .get(apiPath(`/mail-log/${id}`))
          .set('Cookie', cookieHeader(member.token));
        expect(allowed.status).toBe(200);
      }

      await prisma.formPermission.deleteMany({});
      const unlocked = await request(app.server)
        .get(apiPath(`/mail-log/${lockedLineId}`))
        .set('Cookie', cookieHeader(member.token));
      expect(unlocked.status).toBe(200);
      expect(unlocked.text).toContain(LOCKED_BODY_ANSWER);
    });
  });

  describe('„↻ Erneut"', () => {
    // A successful retry moves its line to `queued`, and a `queued` line
    // answers 409 („nur eine fehlgeschlagene Zeile") — so without this the
    // *second* case's control would fail for a reason that has nothing to do
    // with restrictions, and the first case would be the only one that could
    // ever run.
    beforeEach(async () => {
      await prisma.mailLog.updateMany({
        where: { id: { in: [lockedLineId, openLineId] } },
        data: { status: 'failed', attempts: 5, nextAttemptAt: null },
      });
    });

    /**
     * The route that **sends**. A retry on a form somebody is locked out of
     * would put a mail about that form's answers back on the wire on their
     * command — and the answer has to stay the plain 404, because a 409 („nur
     * eine fehlgeschlagene Zeile") would already confirm the line exists and
     * what state it is in.
     */
    it('answers a locked line exactly as it answers an unknown id', async () => {
      await revokeAccess(lockedFormId, member.id);

      const unknown = await request(app.server)
        .post(apiPath('/mail-log/01919c3f-0000-7000-8000-000000000000/retry'))
        .set(authedMutation(member.token));
      const locked = await request(app.server)
        .post(apiPath(`/mail-log/${lockedLineId}/retry`))
        .set(authedMutation(member.token));

      expect(locked.status).toBe(404);
      expect(locked.status).toBe(unknown.status);
      expect(locked.text).toBe(unknown.text);

      // Nothing was requeued — "a 404 came back" and "the row is still on
      // failed" are two statements, and only the second is the guarantee.
      const stored = await prisma.mailLog.findUniqueOrThrow({
        where: { id: lockedLineId },
        select: { status: true, attempts: true },
      });
      expect(stored.status).toBe('failed');
      expect(stored.attempts).toBe(5);

      // The control: the same session may retry the other form's line.
      const allowed = await request(app.server)
        .post(apiPath(`/mail-log/${openLineId}/retry`))
        .set(authedMutation(member.token));
      expect(allowed.status).toBe(204);
    });

    /**
     * The capped half, on the route that **sends**. Until the review finding
     * this was the sharpest end of the gap: a person who may not read form X's
     * answers could put a mail about them back on the wire on their own
     * command, and a sent mail is the one thing this application cannot take
     * back.
     */
    it('answers a capped line exactly as it answers an unknown id', async () => {
      await capToBlind(lockedFormId, member.id);

      const unknown = await request(app.server)
        .post(apiPath('/mail-log/01919c3f-0000-7000-8000-000000000000/retry'))
        .set(authedMutation(member.token));
      const capped = await request(app.server)
        .post(apiPath(`/mail-log/${lockedLineId}/retry`))
        .set(authedMutation(member.token));

      expect(capped.status).toBe(404);
      expect(capped.status).toBe(unknown.status);
      expect(capped.text).toBe(unknown.text);

      // Nothing was requeued — the row is read raw, because "a 404 came
      // back" says nothing about what the worker will pick up next.
      const stored = await prisma.mailLog.findUniqueOrThrow({
        where: { id: lockedLineId },
        select: { status: true, attempts: true },
      });
      expect(stored.status).toBe('failed');
      expect(stored.attempts).toBe(5);

      // The control: the same session may retry the other form's line.
      const allowed = await request(app.server)
        .post(apiPath(`/mail-log/${openLineId}/retry`))
        .set(authedMutation(member.token));
      expect(allowed.status).toBe(204);
    });
  });
});
