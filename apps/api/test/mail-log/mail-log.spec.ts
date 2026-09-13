import { randomUUID } from 'node:crypto';

import { parseMailLogList, type MailLogEntry } from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE,
  MAIL_LOG_NOT_RETRYABLE_MESSAGE,
  MAIL_LOG_SYSTEM_NOT_RETRYABLE_MESSAGE,
} from '../../src/mail-log/mail-log.service';
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
import { authedMutation, cookieHeader, openSession } from '../support/http';

/**
 * The requirement, server half — the mail log routes against real
 * PostgreSQL.
 *
 * Written the way `CONTRIBUTING.md` demands of a rights or isolation rule: every
 * guarantee is asserted through the case that must **fail**. Three things are
 * proven here and each one has a rule that could be deleted:
 *
 * 1. **`can_manage_settings` *and* `can_view_responses`** . Both single-flag groups appear on their own, each expecting 403 —
 *    „neither flag → 403" would stay green under `RequireAnyPermission` and
 *    would therefore prove nothing about the conjunction. Neither group is
 *    `admin`, and both hold their membership in the **active** tenant.
 * 2. **The tenant boundary**, which for `mail_log` is the *only* one there is:
 *    the table carries no composite foreign key on `(form_id, tenant_id)`
 *    , so nothing under `ScopedMailLogDelegate`
 *    catches a forgotten binding. The **whole payload** is searched for BETA's
 *    traces, not the columns the view happens to render.
 * 3. **„↻ Erneut" really requeues**: `status`, `attempts`, `next_attempt_at`,
 *    the error text that stays, and that **no second line** appears.
 *
 * **Negative probes, measured while writing this file** (each rule removed, the
 * suite run, the rule put back):
 *
 * - `RequireAllPermissions` → `RequireAnyPermission` on both routes: the four
 *   single-flag cases go red (list and retry, once per flag), nothing else.
 * - `where.tenantId = this.tenantId` removed from
 *   `ScopedMailLogDelegate.where()`: the payload probe and the tenant-wide
 *   counters go red — ALPHA is handed BETA's recipient address.
 * - `ScopedMailLogDelegate.requeue` reduced to `{ status: 'queued' }` with
 *   `next_attempt_at` left in the future: the state assertion goes red on
 *   `attempts` and on `next_attempt_at`.
 * - `formId` dropped from the delegate's `where()`: the prefilter cases go red,
 *   entries **and** counters.
 *
 * The result of that last measurement is written into the report of this
 * package; what is deliberately **not** here is the second half of the
 * evidence — „wird tatsächlich erneut versucht, nicht nur umgefärbt", measured
 * on the transport counter. That needs the mail worker and is run
 * centrally once both have landed. This file states the exact row state the
 * worker will find.
 */

const SETUP_TIMEOUT_MS = 180_000;

/** The four KPI tiles, as the response states them. */
interface Counts {
  total: number;
  sent: number;
  failed: number;
  queued: number;
}

describe('Versandprotokoll (Rechte- und Mandantengrenze)', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let app: TestApp;

  let alpha: TenantFixture;
  let beta: TenantFixture;

  /** Sessions of ALPHA, one per permission shape. */
  let bothFlags: string;
  let settingsOnly: string;
  /**
   * The **organisation-wide** settings permission plus `can_view_responses` —
   * and shut out all the same (ADR-0021).
   *
   * The case exists because otherwise the separation would only be asserted:
   * since the log demands `can_manage_form_settings`, somebody with the *wide*
   * permission — the organisation's form standards, appearance, sending
   * identity, SSO — has to be refused here. `can_view_responses` is carried
   * along on this person so that the refusal is not the one of the other half
   * of the conjunction.
   */
  let orgSettingsOnly: string;
  let responsesOnly: string;
  let neitherFlag: string;
  /** A session of BETA, so „ALPHA sees nothing" is not „nothing is there". */
  let betaBothFlags: string;

  let registrationFormId: string;
  let semesterFormId: string;

  /** BETA's traces — every one of them must be absent from ALPHA's payload. */
  let betaFormId: string;
  let betaNotificationId: string;
  let betaMailLogId: string;
  let betaSentMailLogId: string;
  const BETA_RECIPIENT = 'beta-teilnehmer@beta.example';
  const BETA_SENT_RECIPIENT = 'beta-zugestellt@beta.example';
  const BETA_SUBJECT = 'BETA Anmeldung bestaetigt';
  const BETA_ERROR = 'BETA 550 unbekannter Empfaenger';
  const BETA_NOTIFICATION_NAME = 'BETA-Bestaetigung';

  const ALPHA_NOTIFICATION_NAME = 'ALPHA-Bestaetigung';

  /** Explicit timestamps, so „newest first" is an assertion and not a race. */
  const t = (minute: number): Date =>
    new Date(Date.UTC(2026, 6, 20, 9, minute, 0));

  function get(session: string, query = ''): request.Test {
    return request(app.server)
      .get(apiPath(`/mail-log${query}`))
      .set('Cookie', cookieHeader(session));
  }

  function retry(session: string, id: string): request.Test {
    return request(app.server)
      .post(apiPath(`/mail-log/${id}/retry`))
      .set(authedMutation(session));
  }

  /** The list route's payload, parsed against the shared wire contract. */
  async function list(
    session: string,
    query = '',
  ): Promise<{ entries: MailLogEntry[]; counts: Counts }> {
    const response = await get(session, query);
    expect(response.status).toBe(200);
    return parseMailLogList(response.body);
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
    app = testApp;
    const { prisma } = testApp;

    alpha = await createTenant(prisma, 'ALPHA');
    beta = await createTenant(prisma, 'BETA');

    // The four permission shapes of the specification. None of them is `admin`, and
    // each holds its membership in the tenant the session is active in — a
    // pair built from an admin would prove that admins may, not that the
    // conjunction is what decides.
    const both = await createRestrictedMember(prisma, alpha, {
      email: 'both@alpha.example',
      groupName: 'protokoll',
      permissions: { canManageFormSettings: true, canViewResponses: true },
    });
    const settings = await createRestrictedMember(prisma, alpha, {
      email: 'settings@alpha.example',
      groupName: 'einstellungen',
      permissions: { canManageFormSettings: true },
    });
    const orgSettings = await createRestrictedMember(prisma, alpha, {
      email: 'orgsettings@alpha.example',
      groupName: 'organisationsverwaltung',
      permissions: { canManageSettings: true, canViewResponses: true },
    });
    const responses = await createRestrictedMember(prisma, alpha, {
      email: 'responses@alpha.example',
      groupName: 'auswertung',
      permissions: { canViewResponses: true },
    });
    const neither = await createRestrictedMember(prisma, alpha, {
      email: 'neither@alpha.example',
      groupName: 'schriftfuehrer',
      permissions: { canBuild: true },
    });
    const betaBoth = await createRestrictedMember(prisma, beta, {
      email: 'both@beta.example',
      groupName: 'protokoll',
      permissions: { canManageFormSettings: true, canViewResponses: true },
    });
    // Exists so the fixture is not a tenant of exactly one member; the routes
    // are never called with it.
    await createUser(prisma, {
      email: 'admin@alpha.example',
      password: 'test-password',
      tenants: [alpha],
    });

    bothFlags = await openSession(app, both.id, alpha.id);
    settingsOnly = await openSession(app, settings.id, alpha.id);
    orgSettingsOnly = await openSession(app, orgSettings.id, alpha.id);
    responsesOnly = await openSession(app, responses.id, alpha.id);
    neitherFlag = await openSession(app, neither.id, alpha.id);
    betaBothFlags = await openSession(app, betaBoth.id, beta.id);

    const registration = await prisma.form.create({
      data: {
        tenantId: alpha.id,
        title: 'Anmeldung Jahrestagung',
        draftSchema: { pages: [] },
        publicSlug: 'slug-alpha-anmeldung-mail-log',
      },
    });
    registrationFormId = registration.id;

    const semester = await prisma.form.create({
      data: {
        tenantId: alpha.id,
        title: 'Bestandsmeldung',
        draftSchema: { pages: [] },
        publicSlug: 'slug-alpha-semester-mail-log',
      },
    });
    semesterFormId = semester.id;

    const alphaNotification = await prisma.notification.create({
      data: {
        tenantId: alpha.id,
        formId: registrationFormId,
        name: ALPHA_NOTIFICATION_NAME,
        subject: 'Anmeldung bestätigt',
        body: 'Danke.',
        recipients: [{ kind: 'literal', address: 'buero@alpha.example' }],
      },
    });

    // ALPHA: five lines over two forms — two sent, two failed, one queued.
    // Deliberately not one per state: a counter that returns the number of
    // *rows* instead of the number per state would survive a fixture where
    // every tile reads 1.
    await prisma.mailLog.createMany({
      data: [
        {
          tenantId: alpha.id,
          formId: registrationFormId,
          notificationId: alphaNotification.id,
          recipient: 'anna@alpha.example',
          subject: 'Anmeldung bestätigt',
          status: 'sent',
          attempts: 1,
          createdAt: t(1),
          sentAt: t(1),
        },
        {
          tenantId: alpha.id,
          formId: registrationFormId,
          // No notification: the template was deleted afterwards
          // (`SetNull`), and the line still has to be listable.
          recipient: 'bernd@alpha.example',
          subject: 'Anmeldung bestätigt',
          status: 'failed',
          attempts: 5,
          lastError: 'ALPHA 550 unbekannter Empfänger',
          createdAt: t(2),
        },
        {
          tenantId: alpha.id,
          formId: registrationFormId,
          notificationId: alphaNotification.id,
          recipient: 'clara@alpha.example',
          subject: 'Anmeldung bestätigt',
          status: 'queued',
          attempts: 0,
          nextAttemptAt: t(3),
          createdAt: t(3),
        },
        {
          tenantId: alpha.id,
          formId: semesterFormId,
          recipient: 'dora@alpha.example',
          subject: 'Rückmeldung eingegangen',
          status: 'sent',
          attempts: 2,
          createdAt: t(4),
          sentAt: t(4),
        },
        {
          tenantId: alpha.id,
          formId: semesterFormId,
          recipient: 'emil@alpha.example',
          subject: 'Rückmeldung eingegangen',
          status: 'failed',
          attempts: 5,
          lastError: 'ALPHA Zeitüberschreitung',
          createdAt: t(5),
        },
      ],
    });

    const betaForm = await prisma.form.create({
      data: {
        tenantId: beta.id,
        title: 'Anmeldung BETA',
        draftSchema: { pages: [] },
        publicSlug: 'slug-beta-anmeldung-mail-log',
      },
    });
    betaFormId = betaForm.id;

    const betaNotification = await prisma.notification.create({
      data: {
        tenantId: beta.id,
        formId: betaFormId,
        name: BETA_NOTIFICATION_NAME,
        subject: BETA_SUBJECT,
        body: 'BETA Text',
        recipients: [{ kind: 'literal', address: 'buero@beta.example' }],
      },
    });
    betaNotificationId = betaNotification.id;

    const betaLine = await prisma.mailLog.create({
      data: {
        tenantId: beta.id,
        formId: betaFormId,
        notificationId: betaNotificationId,
        recipient: BETA_RECIPIENT,
        subject: BETA_SUBJECT,
        status: 'failed',
        attempts: 5,
        lastError: BETA_ERROR,
        createdAt: t(6),
      },
    });
    betaMailLogId = betaLine.id;

    /**
     * A **delivered** line of BETA, and it is here for one reason: without it
     * the tenant binding of `ScopedMailLogDelegate.findById` is not covered by
     * anything. Removing it and leaving only the one in `requeue` keeps every
     * other case green — ALPHA still gets 404 on BETA's *failed* line, because
     * the update simply matches nothing. What changes is the answer on a line
     * in another state: 409 instead of 404, which tells an outsider that the
     * line exists and has already gone out. That is exactly the oracle
     * out, so it gets its own case below.
     */
    const betaSentLine = await prisma.mailLog.create({
      data: {
        tenantId: beta.id,
        formId: betaFormId,
        notificationId: betaNotificationId,
        recipient: BETA_SENT_RECIPIENT,
        subject: BETA_SUBJECT,
        status: 'sent',
        attempts: 1,
        createdAt: t(7),
        sentAt: t(7),
      },
    });
    betaSentMailLogId = betaSentLine.id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await database?.release();
  });

  /**
   * The specification, as a pair per flag.
   *
   * The retry cases address an id that does not exist, on purpose: the guard
   * chain runs before the handler, so a group that is refused sees 403 and a
   * group that is let through sees 404. That difference is the whole
   * assertion, and it needs no row — a row would only add a way for the test
   * to pass for the wrong reason.
   */
  describe('permissions — both flags, not either', () => {
    // One `it` per route and per flag rather than four assertions in two: a
    // test that stops at its first failed expectation would have hidden half
    // of the probe, and the probe is the whole point of these four.
    it('refuses the list to a group that only manages settings', async () => {
      const response = await get(settingsOnly);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        message: MISSING_PERMISSION_MESSAGE,
      });
    });

    it('refuses „↻ Erneut" to a group that only manages settings', async () => {
      const response = await retry(settingsOnly, randomUUID());
      expect(response.status).toBe(403);
    });

    /**
     * ADR-0021, the forbidden case of the separation: the organisation-wide
     * `can_manage_settings` does **not** open this log, not even with
     * `can_view_responses` next to it. Without this case the new permission
     * would be no more than a second name for the old one.
     */
    it('refuses the list to a group holding only the organisation-wide settings right', async () => {
      const response = await get(orgSettingsOnly);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        message: MISSING_PERMISSION_MESSAGE,
      });
    });

    it('refuses „↻ Erneut" to that same group', async () => {
      const response = await retry(orgSettingsOnly, randomUUID());
      expect(response.status).toBe(403);
    });

    it('refuses the list to a group that only views responses', async () => {
      const response = await get(responsesOnly);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        message: MISSING_PERMISSION_MESSAGE,
      });
    });

    it('refuses „↻ Erneut" to a group that only views responses', async () => {
      const response = await retry(responsesOnly, randomUUID());
      expect(response.status).toBe(403);
    });

    it('refuses a group with neither flag', async () => {
      expect((await get(neitherFlag)).status).toBe(403);
      expect((await retry(neitherFlag, randomUUID())).status).toBe(403);
    });

    it('refuses a request without a session at all', async () => {
      const response = await request(app.server).get(apiPath('/mail-log'));
      expect(response.status).toBe(401);
    });

    /**
     * The other half of each pair. The retry answers 404 rather than 403 —
     * the id is unknown — which is what shows the guard chain let this caller
     * through instead of the route being closed to everyone.
     */
    it('lets a group with both flags in', async () => {
      expect((await get(bothFlags)).status).toBe(200);

      const retried = await retry(bothFlags, randomUUID());
      expect(retried.status).toBe(404);
      expect(retried.body).toMatchObject({
        message: MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE,
      });
    });

    it('refuses a mutating call without the CSRF header', async () => {
      // The same caller that gets 404 above — so a 403 here is the CSRF guard
      // and not a permission.
      const response = await request(app.server)
        .post(apiPath(`/mail-log/${randomUUID()}/retry`))
        .set('Cookie', cookieHeader(bothFlags));
      expect(response.status).toBe(403);
    });
  });

  describe('tenant boundary — the only one this table has', () => {
    /**
     * The **whole** payload, not the columns the table renders: a leak through
     * an unrendered field is still a leak, and so in as many
     * words. Searched on the raw response text, so nothing depends on which
     * keys the parser happens to keep.
     */
    it('shows ALPHA no trace of BETA anywhere in the payload', async () => {
      const response = await get(bothFlags);
      expect(response.status).toBe(200);

      for (const trace of [
        beta.id,
        betaFormId,
        betaNotificationId,
        betaMailLogId,
        betaSentMailLogId,
        BETA_RECIPIENT,
        BETA_SENT_RECIPIENT,
        BETA_SUBJECT,
        BETA_ERROR,
        BETA_NOTIFICATION_NAME,
      ]) {
        expect(response.text).not.toContain(trace);
      }
    });

    /**
     * The counter-check that makes the probe above mean something: BETA's line
     * exists and is readable — by BETA. Without this, „ALPHA sees no trace"
     * would also be true of a route that returns nothing at all.
     */
    it('shows BETA its own lines, and only those', async () => {
      const { entries, counts } = await list(betaBothFlags);
      expect(entries.map((entry) => entry.recipient)).toEqual([
        BETA_SENT_RECIPIENT,
        BETA_RECIPIENT,
      ]);
      expect(entries[1]).toMatchObject({
        id: betaMailLogId,
        recipient: BETA_RECIPIENT,
        notificationName: BETA_NOTIFICATION_NAME,
        status: 'failed',
        lastError: BETA_ERROR,
      });
      expect(counts).toEqual({ total: 2, sent: 1, failed: 1, queued: 0 });
    });

    /** The tenant id is a server-side fact and has no business on the wire. */
    it('carries no tenant id in the payload', async () => {
      const response = await get(bothFlags);
      expect(response.text).not.toContain(alpha.id);
    });

    it('does not requeue a line of another organisation', async () => {
      const response = await retry(bothFlags, betaMailLogId);
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        message: MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE,
      });

      // „Answered 404" and „changed nothing" are two statements, and only the
      // second one is the guarantee.
      const stored = await app.prisma.mailLog.findUniqueOrThrow({
        where: { id: betaMailLogId },
      });
      expect(stored.status).toBe('failed');
      expect(stored.attempts).toBe(5);
    });

    /**
     * **404, not 409** — and the difference is the whole test.
     *
     * BETA's line has already been delivered, so a retry on it would be
     * „already sent" *if the caller were allowed to know that*. They are not:
     * a status is a fact about another organisation's post, and an answer that varies
     * with it is an oracle for what other organisations send and to whom. This is the
     * case that makes the tenant binding in
     * `ScopedMailLogDelegate.findById` load-bearing; the one in `requeue`
     * alone cannot produce it, because an update that matches nothing looks
     * the same from outside as a line that does not exist.
     */
    it('does not reveal the state of another organisation’s line', async () => {
      const response = await retry(bothFlags, betaSentMailLogId);
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        message: MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE,
      });
    });
  });

  describe('list and the four KPI tiles', () => {
    it('lists the whole organisation, newest first, with the notification name', async () => {
      const { entries, counts } = await list(bothFlags);

      expect(entries.map((entry) => entry.recipient)).toEqual([
        'emil@alpha.example',
        'dora@alpha.example',
        'clara@alpha.example',
        'bernd@alpha.example',
        'anna@alpha.example',
      ]);
      expect(counts).toEqual({ total: 5, sent: 2, failed: 2, queued: 1 });

      const anna = entries.find(
        (entry) => entry.recipient === 'anna@alpha.example',
      );
      expect(anna).toMatchObject({
        notificationName: ALPHA_NOTIFICATION_NAME,
        formId: registrationFormId,
        status: 'sent',
        attempts: 1,
      });
      expect(anna?.sentAt).not.toBe(null);

      // A line whose notification was deleted stays listable and says so with
      // `null` rather than disappearing (`SetNull`).
      const bernd = entries.find(
        (entry) => entry.recipient === 'bernd@alpha.example',
      );
      expect(bernd).toMatchObject({
        notificationName: null,
        status: 'failed',
        attempts: 5,
        lastError: 'ALPHA 550 unbekannter Empfänger',
      });
    });

    /** „Gesamt" is the absence of a status, not a fourth one. */
    it('narrows the table by status and leaves the tiles alone', async () => {
      const { entries, counts } = await list(bothFlags, '?status=failed');

      expect(entries.map((entry) => entry.recipient)).toEqual([
        'emil@alpha.example',
        'bernd@alpha.example',
      ]);
      expect(entries.every((entry) => entry.status === 'failed')).toBe(true);
      // The tiles are the filter — clicking one must not zero the other three.
      expect(counts).toEqual({ total: 5, sent: 2, failed: 2, queued: 1 });
    });

    /**
     * The prefilter of the specification — and the counters follow it, because the
     * tiles sit above the table and have to describe the same rows.
     */
    it('prefilters on a form, tiles included', async () => {
      const { entries, counts } = await list(
        bothFlags,
        `?formId=${registrationFormId}`,
      );

      expect(entries.map((entry) => entry.recipient)).toEqual([
        'clara@alpha.example',
        'bernd@alpha.example',
        'anna@alpha.example',
      ]);
      expect(
        entries.every((entry) => entry.formId === registrationFormId),
      ).toBe(true);
      expect(counts).toEqual({ total: 3, sent: 1, failed: 1, queued: 1 });
    });

    it('combines both filters', async () => {
      const { entries, counts } = await list(
        bothFlags,
        `?formId=${semesterFormId}&status=sent`,
      );

      expect(entries.map((entry) => entry.recipient)).toEqual([
        'dora@alpha.example',
      ]);
      expect(counts).toEqual({ total: 2, sent: 1, failed: 1, queued: 0 });
    });

    /**
     * A form of another organisation is not a filter that shows its lines — it is a
     * filter that matches nothing, because the tenant is added to the same
     * statement.
     */
    it('answers empty for a form of another organisation', async () => {
      const { entries, counts } = await list(
        bothFlags,
        `?formId=${betaFormId}`,
      );
      expect(entries).toEqual([]);
      expect(counts).toEqual({ total: 0, sent: 0, failed: 0, queued: 0 });
    });

    /** Parsed, not cast: an unknown status is refused rather than ignored. */
    it('refuses an unknown status and a malformed form id', async () => {
      expect((await get(bothFlags, '?status=unterwegs')).status).toBe(400);
      expect((await get(bothFlags, '?formId=nicht-uuid')).status).toBe(400);
    });
  });

  /**
   * „↻ Erneut" — last on purpose: it moves a line from „Fehlgeschlagen" to „In
   * Warteschlange", so it would rewrite the KPI numbers the block above
   * asserts. Its own fixtures are created here, after those tests have run.
   */
  describe('„↻ Erneut" ', () => {
    let failedId: string;
    let sentId: string;
    let rowsBefore: number;

    beforeAll(async () => {
      const failed = await app.prisma.mailLog.create({
        data: {
          tenantId: alpha.id,
          formId: registrationFormId,
          recipient: 'friedrich@alpha.example',
          subject: 'Anmeldung bestätigt',
          status: 'failed',
          attempts: 5,
          lastError: 'ALPHA 421 Server überlastet',
          // Exhausted and parked in the future — the state a line is actually
          // in when somebody reaches for the button.
          nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000),
          createdAt: t(7),
        },
      });
      failedId = failed.id;

      const sent = await app.prisma.mailLog.create({
        data: {
          tenantId: alpha.id,
          formId: registrationFormId,
          recipient: 'gustav@alpha.example',
          subject: 'Anmeldung bestätigt',
          status: 'sent',
          attempts: 1,
          createdAt: t(8),
          sentAt: t(8),
        },
      });
      sentId = sent.id;

      rowsBefore = await app.prisma.mailLog.count();
    });

    /**
     * The full state change, column by column — this is what the central
     * mail worker test will find when it runs afterwards.
     */
    it('resets the line and hands it back to the worker', async () => {
      const before = new Date();
      const response = await retry(bothFlags, failedId);
      const after = new Date();

      expect(response.status).toBe(204);
      expect(response.text).toBe('');

      const stored = await app.prisma.mailLog.findUniqueOrThrow({
        where: { id: failedId },
      });
      expect(stored.status).toBe('queued');
      // Not merely „recoloured": on an exhausted line the counter is what
      // decides whether the worker will bother, so 5 → 0 is what matters here.
      expect(stored.attempts).toBe(0);
      expect(stored.sentAt).toBe(null);
      // Due **now**, not at the far end of the old backoff — the next worker
      // run has to claim it.
      expect(stored.nextAttemptAt).not.toBe(null);
      expect(stored.nextAttemptAt?.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
      expect(stored.nextAttemptAt?.getTime()).toBeLessThanOrEqual(
        after.getTime(),
      );
      // The reason stays readable until the next result replaces it.
      expect(stored.lastError).toBe('ALPHA 421 Server überlastet');

      // One line per recipient: a retry is another attempt at the
      // same delivery, never a second row.
      expect(await app.prisma.mailLog.count()).toBe(rowsBefore);
      expect(
        await app.prisma.mailLog.count({
          where: { recipient: 'friedrich@alpha.example' },
        }),
      ).toBe(1);
    });

    /** The status the view offers the button on is the one it accepts. */
    it('shows the requeued line as queued in the list', async () => {
      const { entries } = await list(bothFlags, '?status=queued');
      const requeued = entries.find((entry) => entry.id === failedId);
      expect(requeued).toMatchObject({ status: 'queued', attempts: 0 });
      expect(requeued?.nextAttemptAt).not.toBe(null);
    });

    /**
     * A sent mail cannot be taken back, so it must not be sendable twice by a
     * misplaced click.
     */
    it('refuses to requeue a line that already went out', async () => {
      const response = await retry(bothFlags, sentId);
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        message: MAIL_LOG_NOT_RETRYABLE_MESSAGE,
      });

      const stored = await app.prisma.mailLog.findUniqueOrThrow({
        where: { id: sentId },
      });
      expect(stored.status).toBe('sent');
      expect(stored.attempts).toBe(1);
      expect(stored.sentAt).not.toBe(null);
    });

    /** A second click on the now-queued line changes nothing further. */
    it('refuses to requeue a line that is already waiting', async () => {
      const response = await retry(bothFlags, failedId);
      expect(response.status).toBe(409);

      const stored = await app.prisma.mailLog.findUniqueOrThrow({
        where: { id: failedId },
      });
      expect(stored.status).toBe('queued');
      expect(stored.attempts).toBe(0);
    });

    /**
     * **This permission does not send a system mail again** (ADR-0020, a
     * review concern).
     *
     * „↻ Erneut" is the only action of this page that *sends*, and since
     * ADR-0021 it sits behind the standard group `editor`. A reset mail,
     * however, lies in this organisation only because `mail_log.tenant_id` is
     * NOT NULL and the **oldest** membership decided the coin toss
     * (ADR-0020 §8) — it belongs to the account, not to the
     * organisation. Without this refusal an `editor` could repeatedly send a
     * stranger a genuine mail of the installation, complete with a freshly
     * built reset link, into their inbox.
     *
     * Measured on the row and not on the status code alone: the refusal must
     * not have touched anything, otherwise it would be a refusal with an effect.
     */
    it('refuses to requeue a system mail, whatever it is worth to the caller', async () => {
      const system = await app.prisma.mailLog.create({
        data: {
          tenantId: alpha.id,
          // Without a form — that is exactly what `trigger = 'system'`
          // states, and that is why the form restriction does not bite here at all.
          recipient: 'superadmin@example.org',
          subject: 'Passwort zurücksetzen',
          status: 'failed',
          attempts: 5,
          lastError: 'ALPHA 421 Server überlastet',
          trigger: 'system',
          createdAt: t(9),
        },
      });

      const response = await retry(bothFlags, system.id);

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        message: MAIL_LOG_SYSTEM_NOT_RETRYABLE_MESSAGE,
      });

      const stored = await app.prisma.mailLog.findUniqueOrThrow({
        where: { id: system.id },
      });
      expect(stored.status).toBe('failed');
      expect(stored.attempts).toBe(5);
      expect(stored.nextAttemptAt).toBe(null);
    });

    /**
     * The counter-check without which the case above would also be green for a
     * button that repeats **nothing** any more: an ordinary line of the same
     * organisation still goes back into the queue.
     */
    it('still requeues an ordinary failed line of the same organisation', async () => {
      const ordinary = await app.prisma.mailLog.create({
        data: {
          tenantId: alpha.id,
          formId: registrationFormId,
          recipient: 'henriette@alpha.example',
          subject: 'Anmeldung bestätigt',
          status: 'failed',
          attempts: 5,
          trigger: 'submit',
          createdAt: t(10),
        },
      });

      expect((await retry(bothFlags, ordinary.id)).status).toBe(204);
      expect(
        (
          await app.prisma.mailLog.findUniqueOrThrow({
            where: { id: ordinary.id },
          })
        ).status,
      ).toBe('queued');
    });
  });
});
