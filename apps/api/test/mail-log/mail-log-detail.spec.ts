import { randomUUID } from 'node:crypto';

import {
  EDIT_LINK_MARK,
  EDIT_LINK_REDACTED_LABEL,
  parseMailLogDetail,
  parseMailLogList,
} from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE } from '../../src/mail-log/mail-log.service';
import { MISSING_PERMISSION_MESSAGE } from '../../src/tenancy/group-permission.guard';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
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

/**
 * The detail route (the requirements: „Die gerenderte Mail im
 * Versandprotokoll ansehen"). `mail-log.spec.ts` covers the list and „↻
 * Erneut"; this file is the one row `GET /mail-log/:id` adds.
 *
 * Four things are proven here, each with the case that must **fail**
 * (`CONTRIBUTING.md`):
 *
 * 1. The same conjunction as the list — `can_manage_settings` *and*
 *    `can_view_responses` — because this route's payload carries answer
 *    values as directly as the export ever did (`mail-log.controller.ts`).
 * 2. **The tenant boundary**, which for `mail_log` is the only one there is:
 *    a foreign row answers 404, not 403 (which would confirm it exists) and
 *    not 200 (which would hand out its body).
 * 3. The list still carries no body, `trigger` included.
 * 4. **`{{bearbeiten}}` resolves to a label, never the live address**
 *    (a review finding of the 2026-07-28 review): this route proves read rights, and
 *    the edit link is a write capability on a stranger's answer. The proof is
 *    not „a label is shown" but „the token value is nowhere in the body" —
 *    see `render() → 'redacted'` (`MailLogService.detail`).
 *
 * **Negative probes, measured while writing this file** (each rule removed,
 * the suite run, the rule put back):
 *
 * - `RequireAllPermissions` → `RequireAnyPermission` on `detail`: the two
 *   single-flag cases below go red.
 * - `tenantId: this.tenantId` removed from `ScopedMailLogDelegate.findById`'s
 *   `where`: „a foreign row answers 404" goes green for the wrong reason no
 *   longer — it goes **red**, because the route then answers 200 with BETA's
 *   rendered body. That is the case the requirement singled out by name
 *   (removing `tenantId` from `findById` once „left the suite green"); this
 *   file's tenant-boundary case is written to catch exactly that removal.
 * - `detail()`'s `render()` call switched back to `'real'` (the earlier
 *   behaviour): the evidence above goes red — the token and the base URL
 *   reappear in `bodyText`/`bodyHtml`.
 */

const SETUP_TIMEOUT_MS = 180_000;

/** The organisation's reply address as it applies **at the time of sending**. */
const FROZEN_REPLY_TO = 'antwort-alt@alpha-detail.example';

/** And the one it is changed to afterwards — the row must never carry it. */
const LATER_REPLY_TO = 'antwort-neu@alpha-detail.example';

describe('Versandprotokoll — Detail („Die gerenderte Mail ansehen")', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp;

  let alpha: TenantFixture;
  let beta: TenantFixture;

  let bothFlags: string;
  let builderSession: string;
  let settingsOnly: string;
  /** The organisation-wide settings right — without effect here (ADR-0021). */
  let orgSettingsOnly: string;
  let responsesOnly: string;
  let betaBothFlags: string;

  const app = (): TestApp => testApp;

  function get(session: string, id: string): request.Test {
    return request(app().server)
      .get(apiPath(`/mail-log/${id}`))
      .set('Cookie', cookieHeader(session));
  }

  function list(session: string): request.Test {
    return request(app().server)
      .get(apiPath('/mail-log'))
      .set('Cookie', cookieHeader(session));
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      // The submission below goes through the real public route; one address
      // per request is what keeps it clear of that route's own rate limit
      // (proven in `public-forms.spec.ts`), same as `frozen-mail-body.spec.ts`.
      env: { TRUST_PROXY_HOPS: 1 },
      // The edit link this suite reads out of a submission is absolute, and its
      // base address is a row .
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
    });

    alpha = await createTenant(testApp.prisma, 'ALPHA-DETAIL');
    beta = await createTenant(testApp.prisma, 'BETA-DETAIL');

    const both = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'both@alpha-detail.example',
      groupName: 'protokoll',
      permissions: { canManageFormSettings: true, canViewResponses: true },
    });
    // Only for building the fixture form below: `POST /forms` and friends ask
    // for `canBuild`, which the mail log's own conjunction does not
    // include (`mail-log.controller.ts`) — the two rights are deliberately
    // not the same one, so the fixture needs its own session for them.
    const builder = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'builder@alpha-detail.example',
      groupName: 'formulare',
      permissions: { canBuild: true },
    });
    const settings = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'settings@alpha-detail.example',
      groupName: 'einstellungen',
      permissions: { canManageFormSettings: true },
    });
    // ADR-0021: the **organisation-wide** settings right, with
    // `can_view_responses` beside it — and still shut out. Without this person
    // the separation would prove nothing, because every refusal could hang on
    // the other half of the conjunction.
    const orgSettings = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'orgsettings@alpha-detail.example',
      groupName: 'organisationsverwaltung',
      permissions: { canManageSettings: true, canViewResponses: true },
    });
    const responses = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'responses@alpha-detail.example',
      groupName: 'auswertung',
      permissions: { canViewResponses: true },
    });
    const betaBoth = await createRestrictedMember(testApp.prisma, beta, {
      email: 'both@beta-detail.example',
      groupName: 'protokoll',
      permissions: { canManageFormSettings: true, canViewResponses: true },
    });
    // A tenant of exactly one member is a fixture nobody would trust; this
    // keeps ALPHA the same shape `mail-log.spec.ts` uses.
    await createUser(testApp.prisma, {
      email: 'admin@alpha-detail.example',
      password: 'test-password',
      tenants: [alpha],
    });

    bothFlags = await openSession(testApp, both.id, alpha.id);
    builderSession = await openSession(testApp, builder.id, alpha.id);
    settingsOnly = await openSession(testApp, settings.id, alpha.id);
    orgSettingsOnly = await openSession(testApp, orgSettings.id, alpha.id);
    responsesOnly = await openSession(testApp, responses.id, alpha.id);
    betaBothFlags = await openSession(testApp, betaBoth.id, beta.id);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence + the `{{bearbeiten}}` decision: a real row, sent through the
  // real submit and publish routes — so the body really is the one
  // `QueuedBodyRenderer` would have sent, not a hand-typed stand-in.
  // ═══════════════════════════════════════════════════════════════════════

  describe('an authorised read of a real line', () => {
    let mailLogId: string;
    let editToken: string;

    beforeAll(async () => {
      /*
       * **The organisation's reply address, set *before* the sending**
       * (the requirement). It is the middle one of the three layers;
       * the notification below carries none of its own, so this is the value
       * `submissionMails` freezes into `mail_log.reply_to` at the enqueue —
       * and the one the case further below finds again unchanged, after the
       * organisation's column has long said something else.
       */
      await app().prisma.tenant.update({
        where: { id: alpha.id },
        data: { replyTo: FROZEN_REPLY_TO },
      });

      const created = await request(app().server)
        .post(apiPath('/forms'))
        .set(authedMutation(builderSession))
        .send({ title: 'Anmeldung Detailtest' });
      expect(created.status).toBe(201);
      const form = created.body as {
        id: string;
        revision: number;
        publicSlug: string;
      };

      const saved = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(builderSession))
        .send({
          title: 'Anmeldung Detailtest',
          definition: {
            pages: [
              {
                id: '019ffb00-0000-7000-8000-0000000000d1',
                title: 'Seite 1',
                questions: [],
              },
            ],
          },
          revision: form.revision,
        });
      expect(saved.status).toBe(200);
      const savedForm = saved.body as { revision: number };

      const published = await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(builderSession))
        .send({ revision: savedForm.revision });
      expect(published.status).toBe(200);

      const settingsRow = await app().prisma.form.findUniqueOrThrow({
        where: { id: form.id },
        select: { settingsRevision: true, tenantId: true },
      });
      const tenantRow = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: settingsRow.tenantId },
        select: { formDefaultsRevision: true },
      });
      const configured = await request(app().server)
        .put(apiPath(`/forms/${form.id}/settings`))
        .set(authedMutation(bothFlags))
        .send({
          overridden: {
            access: true,
            confirm: true,
            display: false,
            budget: false,
          },
          values: { allowEdit: true },
          revision: settingsRow.settingsRevision,
          tenantRevision: tenantRow.formDefaultsRevision,
        });
      expect(configured.status).toBe(200);

      const notification = await request(app().server)
        .post(apiPath(`/forms/${form.id}/notifications`))
        .set(authedMutation(bothFlags))
        .send({
          name: 'Bestätigung',
          subject: 'Anmeldung eingegangen',
          // Default format is `html` — both `bodyText` and `bodyHtml` land in
          // the row, which is exactly what the evidence asks for.
          body: '<p>Danke fürs Anmelden. Ändern: {{bearbeiten}}</p>',
          recipients: [
            { kind: 'literal', address: 'buero@alpha-detail.example' },
          ],
          replyTo: null,
        });
      expect(notification.status).toBe(201);

      const submitted = await request(app().server)
        .post(apiPath(`/public/forms/${form.publicSlug}/responses`))
        .set('X-Forwarded-For', '198.51.100.10')
        .send({ answers: {} });
      expect(submitted.status).toBe(200);
      const editUrl = (submitted.body as { editUrl: string | null }).editUrl;
      expect(editUrl).not.toBeNull();
      editToken = (editUrl ?? '').split('/a/')[1] ?? '';
      expect(editToken).not.toBe('');

      const row = await app().prisma.mailLog.findFirstOrThrow({
        where: { formId: form.id },
      });
      mailLogId = row.id;
      // The mark really is what got frozen in — otherwise the assertions
      // below would hold for the wrong reason (nothing left to resolve).
      expect(row.bodyText).toContain(EDIT_LINK_MARK);
    });

    /**
     * „Beim Senden, nicht beim Einreihen" — **measured on the production
     * path** (a review finding).
     *
     * The reproduction of the requirement („die Spalte beim Einreihen statt
     * beim Senden schreiben") had until now only been driven as a *column
     * default*. The application variant — `senderIdentity: 'system'` in
     * `toMailLogRow`, that is in the enqueue path of
     * `public-forms.service.ts` — stayed green on every case: none of them
     * enqueued over the real path, all wrote their rows themselves with
     * `prisma.mailLog.create`. This one came out of a real public submission
     * and is therefore the only place at which this move shows up.
     */
    it('names no identity on the line the real submission enqueued', async () => {
      const row = await app().prisma.mailLog.findUniqueOrThrow({
        where: { id: mailLogId },
        select: { status: true, senderIdentity: true, senderAddress: true },
      });
      // Nothing has been sent — the worker does not run in tests.
      expect(row.status).toBe('queued');
      expect(row.senderIdentity).toBe(null);
      expect(row.senderAddress).toBe(null);
    });

    it('answers recipient, subject, both bodies, status and trigger — with the link redacted, not resolved', async () => {
      const response = await get(bothFlags, mailLogId);
      expect(response.status).toBe(200);
      const detail = parseMailLogDetail(response.body);

      expect(detail).toMatchObject({
        id: mailLogId,
        recipient: 'buero@alpha-detail.example',
        subject: 'Anmeldung eingegangen',
        status: 'queued',
        trigger: 'submit',
      });

      // The mark is gone — a link *exists* — but the address it resolves to
      // must never leave a route that only proves `can_view_responses`. The
      // token is a write capability on a stranger's answer; a read route
      // handing it out would turn „read" into „overwrite, unattributed"
      // . So: the label, not the URL, and — the actual security
      // property — the token value nowhere in either body, not even
      // substring-buried in a longer address.
      expect(detail.bodyText).toContain(EDIT_LINK_REDACTED_LABEL);
      expect(detail.bodyText).not.toContain(EDIT_LINK_MARK);
      expect(detail.bodyText).not.toContain(editToken);
      expect(detail.bodyText).not.toContain(`${TEST_PUBLIC_BASE_URL}/a/`);

      expect(detail.bodyHtml).toContain(EDIT_LINK_REDACTED_LABEL);
      expect(detail.bodyHtml).not.toContain(EDIT_LINK_MARK);
      expect(detail.bodyHtml).not.toContain(editToken);
      expect(detail.bodyHtml).not.toContain(`${TEST_PUBLIC_BASE_URL}/a/`);
      // No anchor **to the edit path** — the label replaces the anchor, it is
      // not its visible text (the mark stood in a plain `<p>`, so any `<a`
      // with `/a/` here could only come from resolving the real link).
      //
      // ⚠️ **What is checked is the path, no longer the bare base address.**
      // Since the footer links into the system, the base address stands in
      // every mail — in this view as well, because it shows what went out.
      // It is no authorisation: it is the public address of this
      // organisation, which stands on every form link. The security property
      // is and remains the **token**, and the two lines above check it
      // unchanged.
      expect(detail.bodyHtml).not.toMatch(/<a [^>]*\/a\//);
    });

    /**
     * **The reply address of the row — frozen at the enqueue**
     * (the requirement).
     *
     * Two promises in one case, and they hang on each other:
     *
     * 1. The row carries one at all — that of the **organisation**, although
     *    the notification itself has none. That proves that the whole chain
     *    was evaluated at the enqueue and not only the topmost layer.
     * 2. It does **not** change when the layer below it changes. That is the
     *    reason the column exists: the log says what went out, not what would
     *    apply today.
     *
     * The change happens **after** the enqueue and is driven over the real
     * column, not simulated. Afterwards it is turned back — no other case of
     * this file reads that layer, and a test whose statement depends on its
     * position is no statement.
     *
     * *Reproductions, measured (2026-08-06):*
     *
     * - in `MailLogService.detail` overwrite the field after `toEntry` with
     *   *today's* value (`(await scope.tenant.replyTo())?.replyTo ?? null`)
     *   — this case goes red, and it does so on the second half: „expected
     *   'antwort-neu@…' to be 'antwort-alt@…'". The first half stays green
     *   while doing so, because both values are equal before the change —
     *   **which is why both halves are needed**;
     * - remove `replyTo: true` from `MAIL_LOG_VIEW_SELECT`: that already
     *   breaks the type check (`toEntry` reads a column the projection does
     *   not fetch), so it never gets as far as this run.
     */
    it('shows the reply address frozen at the enqueue, not the one in force today', async () => {
      const before = parseMailLogDetail((await get(bothFlags, mailLogId)).body);
      expect(before.replyTo).toBe(FROZEN_REPLY_TO);

      await app().prisma.tenant.update({
        where: { id: alpha.id },
        data: { replyTo: LATER_REPLY_TO },
      });
      try {
        const after = parseMailLogDetail(
          (await get(bothFlags, mailLogId)).body,
        );
        expect(after.replyTo).toBe(FROZEN_REPLY_TO);
        expect(after.replyTo).not.toBe(LATER_REPLY_TO);
      } finally {
        await app().prisma.tenant.update({
          where: { id: alpha.id },
          data: { replyTo: FROZEN_REPLY_TO },
        });
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — the conjunction, one flag missing at a time.
  // ═══════════════════════════════════════════════════════════════════════

  describe('permissions — both flags, not either', () => {
    it('refuses a group that only manages settings', async () => {
      const response = await get(settingsOnly, randomUUID());
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        message: MISSING_PERMISSION_MESSAGE,
      });
    });

    it('refuses a group holding only the organisation-wide settings right', async () => {
      const response = await get(orgSettingsOnly, randomUUID());
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        message: MISSING_PERMISSION_MESSAGE,
      });
    });

    it('refuses a group that only views responses', async () => {
      const response = await get(responsesOnly, randomUUID());
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        message: MISSING_PERMISSION_MESSAGE,
      });
    });

    /**
     * **A malformed id answers like an unknown one** .
     *
     * Until 2026-08-12 it did not: `findById` passed the literal through, the
     * database objected, and the caller got a **500**. That is the piece of
     * information this case is meant to prevent — it tells them that their
     * string made it all the way into the query. The existing cases only
     * checked `randomUUID()`, that is exclusively the well-formed id.
     *
     * *Counter-check:* remove the `isUuid` line from `MailLogService.detail` →
     * this case goes red (500 instead of 404), all the others stay green.
     */
    it('answers a malformed id exactly like an unknown one', async () => {
      const response = await get(bothFlags, 'nicht-echt');
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        message: MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE,
      });
    });

    it('refuses a request without a session at all', async () => {
      const response = await request(app().server).get(
        apiPath(`/mail-log/${randomUUID()}`),
      );
      expect(response.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — the tenant boundary, the only one this table has.
  // ═══════════════════════════════════════════════════════════════════════

  describe('tenant boundary', () => {
    const BETA_SUBJECT = 'BETA Detail Betreff';
    const BETA_BODY_MARK = 'BETA-eindeutiger-Rumpftext-Detail';
    let betaMailLogId: string;

    beforeAll(async () => {
      const betaForm = await app().prisma.form.create({
        data: {
          tenantId: beta.id,
          title: 'BETA Formular Detail',
          draftSchema: { pages: [] },
          publicSlug: 'slug-beta-mail-log-detail',
        },
      });
      const betaLine = await app().prisma.mailLog.create({
        data: {
          tenantId: beta.id,
          formId: betaForm.id,
          recipient: 'beta-empfaenger@beta-detail.example',
          subject: BETA_SUBJECT,
          status: 'queued',
          attempts: 0,
          trigger: 'submit',
          bodyText: BETA_BODY_MARK,
          bodyHtml: `<p>${BETA_BODY_MARK}</p>`,
        },
      });
      betaMailLogId = betaLine.id;
    });

    it('answers 404 for a line of another organisation, with no body in the response', async () => {
      const response = await get(bothFlags, betaMailLogId);
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        message: MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE,
      });
      expect(response.text).not.toContain(BETA_BODY_MARK);
      expect(response.text).not.toContain(BETA_SUBJECT);
    });

    it('answers 404 for an id that does not exist at all — the same answer', async () => {
      const response = await get(bothFlags, randomUUID());
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        message: MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE,
      });
    });

    it('shows BETA its own line, body included', async () => {
      const response = await get(betaBothFlags, betaMailLogId);
      expect(response.status).toBe(200);
      const detail = parseMailLogDetail(response.body);
      // `toContain`, not `toBe`: the view renders through the same
      // `QueuedBodyRenderer` as the sending and therefore carries the same
      // footer — that is precisely its promise („shows what went out").
      expect(detail.bodyText).toContain(BETA_BODY_MARK);
      expect(detail.bodyText).toContain(
        'Diese E-Mail wurde automatisch erzeugt.',
      );
      expect(detail.trigger).toBe('submit');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The requirement — the sending identity, on the read side.
  //
  // That the *worker* writes the two columns at send time is proven where it
  // sends (`test/mail/sender-identity.spec.ts`). What is proven here is the
  // other half: that they reach the wire at all, that a `queued` line names
  // none, and — the evidence of that requirement — that a line naming an identity
  // is still 404 for another organisation. `ScopedMailLogDelegate` is the only tenant
  // boundary this table has, so widening its projection is exactly the change
  // that could have leaked one.
  // ═══════════════════════════════════════════════════════════════════════

  describe('Versandidentität', () => {
    const OWN_ADDRESS = 'post@alpha-detail.example';
    const BETA_ADDRESS = 'post@beta-detail.example';
    let sentLineId: string;
    let queuedLineId: string;
    let betaSentLineId: string;

    beforeAll(async () => {
      const sent = await app().prisma.mailLog.create({
        data: {
          tenantId: alpha.id,
          recipient: 'gesendet@alpha-detail.example',
          subject: 'Über den eigenen Block',
          status: 'sent',
          attempts: 1,
          sentAt: new Date(),
          senderIdentity: 'own',
          senderAddress: OWN_ADDRESS,
          bodyText: 'Danke.',
        },
      });
      sentLineId = sent.id;

      const queued = await app().prisma.mailLog.create({
        data: {
          tenantId: alpha.id,
          recipient: 'wartet@alpha-detail.example',
          subject: 'Noch nicht versandt',
          status: 'queued',
          attempts: 0,
          bodyText: 'Danke.',
        },
      });
      queuedLineId = queued.id;

      const betaSent = await app().prisma.mailLog.create({
        data: {
          tenantId: beta.id,
          recipient: 'gesendet@beta-detail.example',
          subject: 'BETA über den eigenen Block',
          status: 'sent',
          attempts: 1,
          sentAt: new Date(),
          senderIdentity: 'own',
          senderAddress: BETA_ADDRESS,
          bodyText: 'Danke.',
        },
      });
      betaSentLineId = betaSent.id;
    });

    it('names the identity and the address of a sent line', async () => {
      const response = await get(bothFlags, sentLineId);
      expect(response.status).toBe(200);
      const detail = parseMailLogDetail(response.body);
      expect(detail.senderIdentity).toBe('own');
      expect(detail.senderAddress).toBe(OWN_ADDRESS);
    });

    it('names none on a queued line — null travels as null, never as „system"', async () => {
      const response = await get(bothFlags, queuedLineId);
      expect(response.status).toBe(200);
      const detail = parseMailLogDetail(response.body);
      expect(detail.senderIdentity).toBe(null);
      expect(detail.senderAddress).toBe(null);
    });

    it('carries both on the list as well, so a whole batch can be read at once', async () => {
      const response = await list(bothFlags);
      expect(response.status).toBe(200);
      const parsed = parseMailLogList(response.body);
      const line = parsed.entries.find((entry) => entry.id === sentLineId);
      expect(line?.senderIdentity).toBe('own');
      expect(line?.senderAddress).toBe(OWN_ADDRESS);
    });

    /**
     * the evidence of the requirement. Not a duplicate of the tenant-boundary
     * block above: that one proves a *body* does not cross, this one proves
     * the newly selected columns do not — the address of another organisation's mail
     * server is precisely the operational datum this feature adds, and the
     * `select` it was added to is the one place the boundary lives.
     */
    it('answers 404 for another organisation’s line, address and all', async () => {
      const response = await get(bothFlags, betaSentLineId);
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        message: MAIL_LOG_ENTRY_NOT_FOUND_MESSAGE,
      });
      expect(response.text).not.toContain(BETA_ADDRESS);

      // And not through the list either — the same boundary, the other route.
      const listed = await list(bothFlags);
      expect(JSON.stringify(listed.body)).not.toContain(BETA_ADDRESS);
    });

    /**
     * „↻ Erneut" after a switch from system to own is the case the requirement
     * „beim Senden, nicht beim Einreihen" decided for. The reverse side of it
     * stands here: a row handed back does **not** keep the old identity,
     * otherwise „System" would stand over a row that is now waiting for the
     * own block.
     */
    it('clears both when a failed line is handed back to the worker', async () => {
      const line = await app().prisma.mailLog.create({
        data: {
          tenantId: alpha.id,
          recipient: 'erneut@alpha-detail.example',
          subject: 'Erneut versuchen',
          status: 'failed',
          attempts: 5,
          lastError: 'Der Mailserver war nicht erreichbar.',
          senderIdentity: 'system',
          senderAddress: 'no-reply@installation.example',
          bodyText: 'Danke.',
        },
      });

      const retry = await request(app().server)
        .post(apiPath(`/mail-log/${line.id}/retry`))
        .set(authedMutation(bothFlags));
      expect(retry.status).toBe(204);

      const after = await get(bothFlags, line.id);
      const detail = parseMailLogDetail(after.body);
      expect(detail.status).toBe('queued');
      expect(detail.senderIdentity).toBe(null);
      expect(detail.senderAddress).toBe(null);
    });

    /**
     * **„↻ Erneut" on an emptied row is forbidden** (a review finding).
     *
     * Nothing would go out — the queue statements exclude a null recipient. The
     * damage is the other direction: `requeue` writes `status`, `sent_at`,
     * `attempts`, `sender_identity` and `sender_address`, which **is** the
     * record physical deletion promises to keep when it empties the personal
     * columns. One click and the line reads `queued` forever, with no outcome,
     * no time and no identity — the operational half destroyed by the button
     * meant to repair a delivery, and the specification predicted exactly this click.
     *
     * The view has hidden the button since `85dd16a`; that is comfort, and this
     * is the boundary. Measured on the route.
     *
     * *Reproduction, measured:* remove the `entry.recipient === null` check
     * from `MailLogService.retry` and this case is red on all four
     * assertions — 204 instead of 409, and the row `queued` with its outcome,
     * its time and its identity gone.
     */
    it('refuses a retry on a line whose data were endgültig gelöscht', async () => {
      const line = await app().prisma.mailLog.create({
        data: {
          tenantId: alpha.id,
          // What physical deletion leaves: the delivery record, and NULL in
          // every column that named a person.
          recipient: null,
          subject: null,
          bodyText: null,
          bodyHtml: null,
          lastError: null,
          status: 'failed',
          attempts: 3,
          sentAt: null,
          senderIdentity: 'system',
          senderAddress: 'no-reply@installation.example',
        },
      });

      const retry = await request(app().server)
        .post(apiPath(`/mail-log/${line.id}/retry`))
        .set(authedMutation(bothFlags));
      expect(retry.status).toBe(409);

      const after = await app().prisma.mailLog.findUniqueOrThrow({
        where: { id: line.id },
        select: {
          status: true,
          attempts: true,
          senderIdentity: true,
          senderAddress: true,
        },
      });
      expect(after.status).toBe('failed');
      expect(after.attempts).toBe(3);
      expect(after.senderIdentity).toBe('system');
      expect(after.senderAddress).toBe('no-reply@installation.example');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — the list still carries no body. It *does* carry the
  // trigger now (a review finding): the table row has to know whether
  // „↻ Erneut" may be offered at all, and `MailLogService.retry` refuses a
  // system line with a 409. What stays out is the body, which is the reason
  // this suite exists — 200 rendered mails on one page view.
  // ═══════════════════════════════════════════════════════════════════════

  describe('the list stays bodyless', () => {
    it('lists a line whose row has a body without the body, but with the trigger', async () => {
      const line = await app().prisma.mailLog.create({
        data: {
          tenantId: alpha.id,
          recipient: 'liste@alpha-detail.example',
          subject: 'Nur die Liste',
          status: 'queued',
          attempts: 0,
          trigger: 'edit',
          bodyText: 'Ein sehr wiedererkennbarer Listentext',
          bodyHtml: '<p>Ein sehr wiedererkennbarer Listentext</p>',
        },
      });

      const response = await list(bothFlags);
      expect(response.status).toBe(200);
      // `parseMailLogList` is `strictObject` — an entry carrying `bodyText` or
      // `bodyHtml` would make this throw before the assertions below even run.
      const parsed = parseMailLogList(response.body);
      const listed = parsed.entries.find((entry) => entry.id === line.id);
      expect(listed).toBeDefined();
      // And the trigger is there, with the value of the column: the row in
      // the browser decides by it whether it offers „↻ Erneut" at all.
      expect(listed?.trigger).toBe('edit');

      // The allow list, on the raw payload — not only through the parser,
      // which a widened `select` could still satisfy today and stop
      // satisfying only once a client starts reading the new key (the same
      // pattern used for the public payload).
      const payload = JSON.stringify(response.body);
      expect(payload).not.toContain('Ein sehr wiedererkennbarer Listentext');
      expect(payload).not.toContain('"bodyText"');
      expect(payload).not.toContain('"bodyHtml"');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The one exception in `{{bearbeiten}}`'s resolution: no answer behind the
  // row at all, resolved to "no link" rather than shown as the raw mark.
  // ═══════════════════════════════════════════════════════════════════════

  it('resolves an orphaned {{bearbeiten}} mark to no link, not to the raw mark', async () => {
    const line = await app().prisma.mailLog.create({
      data: {
        tenantId: alpha.id,
        recipient: 'verwaist@alpha-detail.example',
        subject: 'Ohne Antwort',
        status: 'queued',
        attempts: 0,
        // No `responseId`: `editUrlFor` reads that as "answer physically
        // gone", the ordinary case for a row surviving the trash purge.
        bodyText: `Danke. Ändern: ${EDIT_LINK_MARK}`,
      },
    });

    const response = await get(bothFlags, line.id);
    expect(response.status).toBe(200);
    const detail = parseMailLogDetail(response.body);
    // The body ends after the removed mark; the footer below it is the
    // wrapper, not the body (see the case of the organisation boundary).
    expect(detail.bodyText?.startsWith('Danke. Ändern:')).toBe(true);
    expect(detail.bodyText).not.toContain(EDIT_LINK_MARK);
  });
});
