import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EDIT_LINK_MARK,
  questionPlaceholderToken,
  systemPlaceholderToken,
} from '@formsache/shared';

import { MailWorkerService } from '../../src/mail/mail-worker.service';
import { UNREADABLE_SETTINGS_MAIL_REASON } from '../../src/mail/queued-body-renderer';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { MutableClock } from '../mail/mail-test-context';
import { captureStdio } from '../mail/stdio-capture';
import {
  TEST_PUBLIC_BASE_URL,
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
import { SmtpDouble } from '../support/smtp-double';

/**
 * **The body is frozen at the enqueue — with exactly one exception**
 * (decision of 2026-07-28).
 *
 * Until this suite existed, the body of a queued mail was rendered at **send**
 * time from the notification and the answer as they stood then, while recipient
 * and subject had been fixed at the enqueue. Nobody had decided that asymmetry
 * and it had three consequences in the window between queueing and sending — a
 * window that is days long with a dead mail server or after „↻ Erneut":
 *
 * | changed in the window | subject | body, before |
 * |---|---|---|
 * | somebody edits the notification | old | **new** |
 * | the participant corrects the answer | old | **new** |
 * | the answer is deleted | stands | **unrenderable → fails for good** |
 *
 * Those three are the first three cases below. The rest are the exception: the
 * `{{bearbeiten}}` link, which is deliberately *not* frozen, because whether it
 * leads anywhere is a property of the present (`allowEdit` „on every access", the specification revokes the token with the access word) rather than of the
 * submission.
 *
 * **Every case here drives the real worker.** „What is in the delivered
 * mail" is the only question that matters, and it can only be answered by the
 * transport — the stored column alone would leave a send step that overwrites
 * everything undetected. The one exception is stated as such: case 4 asserts on
 * the **column**, because „not resolved at the enqueue" is a statement about
 * what is written down, and asserting it on the delivered mail would be green
 * for any implementation that produces a URL anywhere along the way.
 */

const PASSWORD = 'test-password';

const PAGE = '019ffb00-0000-7000-8000-0000000000a0';
const NAME_QUESTION = '019ffb00-0000-7000-8000-000000000001';
const MAIL_QUESTION = '019ffb00-0000-7000-8000-000000000002';

const PARTICIPANT = 'anton@example.invalid';

const questionBase = { hint: null, required: false, width: 'full' as const };

const definition = {
  pages: [
    {
      id: PAGE,
      title: 'Anmeldung',
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
      ],
    },
  ],
};

const ANSWERS = {
  [NAME_QUESTION]: 'Anton Aktiv',
  [MAIL_QUESTION]: PARTICIPANT,
};

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

describe('the frozen body, and the one slot left open', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp;
  let tenant: TenantFixture;
  let editor: string;
  let transport: SmtpDouble;
  let clock: MutableClock;
  let worker: MailWorkerService;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    // Always answers: every case here wants the mail to arrive, so what is
    // asserted is its *content* and not whether a queue survives a refusal —
    // that is `submission-mail.spec.ts`' subject.
    transport = new SmtpDouble();
    clock = new MutableClock(new Date());
    testApp = await createTestApp({
      databaseUrl: database.url,
      // The installation's own address is a **row**, not
      // `PUBLIC_BASE_URL` of the environment. A suite
      // that asserts on absolute links has to put one there — which is also
      // what makes „if it is missing, there is no link" a state of its own.
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
      // Own address per request: the public submit route allows 30 a minute per
      // address (proven in `public-forms.spec.ts`).
      env: { TRUST_PROXY_HOPS: 1 },
      transport,
      clock,
    });
    worker = testApp.app.get(MailWorkerService);

    tenant = await createTenant(testApp.prisma, 'FROZEN');
    const user = await createUser(testApp.prisma, {
      email: 'editor@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
    editor = await openSession(testApp, user.id, tenant.id);
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  // ═════════════════════════════════════════════════════════════════════════
  // Fixtures, through the real routes
  // ═════════════════════════════════════════════════════════════════════════

  interface Form {
    readonly id: string;
    readonly slug: string;
  }

  async function publishedForm(title: string): Promise<Form> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(editor))
      .send({ title });
    expect(created.status).toBe(201);
    const form = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };

    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(editor))
      .send({ title, definition, revision: form.revision });
    expect(saved.status).toBe(200);

    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    return { id: form.id, slug: form.publicSlug };
  }

  /** Writes a form's settings through the real route (a `PUT` over the whole document). */
  async function configure(
    formId: string,
    overridden: Record<string, boolean>,
    values: Record<string, unknown>,
  ): Promise<void> {
    const form = await app().prisma.form.findUniqueOrThrow({
      where: { id: formId },
      select: { settingsRevision: true, tenantId: true },
    });
    const tenantRow = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: form.tenantId },
      select: { formDefaultsRevision: true },
    });

    const response = await request(app().server)
      .put(apiPath(`/forms/${formId}/settings`))
      .set(authedMutation(editor))
      .send({
        overridden: {
          access: false,
          confirm: false,
          display: false,
          budget: false,
          ...overridden,
        },
        values,
        revision: form.settingsRevision,
        tenantRevision: tenantRow.formDefaultsRevision,
      });
    expect(response.status).toBe(200);
  }

  async function addNotification(
    formId: string,
    body: object,
  ): Promise<string> {
    const created = await request(app().server)
      .post(apiPath(`/forms/${formId}/notifications`))
      .set(authedMutation(editor))
      // `replyTo` first, so a caller can still say something else about it:
      // the field is required and nullable without a default, and
      // this suite has nothing to say about it.
      .send({ replyTo: null, ...body });
    expect(created.status).toBe(201);
    return (created.body as { id: string }).id;
  }

  /**
   * A published form whose participant confirmation really goes out: the switch
   * of the requirement on, `allowEdit` on, one notification to the address the
   * participant types in.
   */
  async function sendingForm(
    title: string,
    notificationBody: string,
  ): Promise<Form & { notificationId: string }> {
    const form = await publishedForm(title);
    await configure(
      form.id,
      { confirm: true, access: true },
      { allowEdit: true },
    );
    const notificationId = await addNotification(form.id, {
      name: 'Bestätigung',
      subject: 'Anmeldung eingegangen',
      body: notificationBody,
      recipients: [{ kind: 'question', questionId: MAIL_QUESTION }],
    });
    return { ...form, notificationId };
  }

  function submit(
    slug: string,
    body: Record<string, unknown> = {},
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers: ANSWERS, ...body });
  }

  function mailsOf(formId: string) {
    return app().prisma.mailLog.findMany({
      where: { formId },
      orderBy: { recipient: 'asc' },
    });
  }

  /** Runs the worker until the queue is empty and returns what was delivered. */
  async function deliver(): Promise<{
    text: string;
    html: string | undefined;
  }> {
    const before = transport.attemptCount;
    const run = await worker.runOnce();
    expect(run.sent).toBeGreaterThan(0);
    expect(transport.attemptCount).toBe(before + run.sent);
    const delivered = transport.attempts.at(-1);
    expect(delivered).toBeDefined();
    return { text: delivered?.text ?? '', html: delivered?.html };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 1–3: what the freeze is for
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **The core case.** A confirmation confirms what held at the moment it was
   * sent — not what somebody wrote into the notification afterwards.
   *
   * Both halves are asserted: the old sentence **positively** and the new one
   * **negatively**. „Does not contain the old text" alone would be green for
   * an empty mail, and „does not contain the new one" alone for a delivery
   * that never happened.
   */
  it('delivers the text the notification had when the answer arrived', async () => {
    const form = await sendingForm(
      'Benachrichtigung danach geändert',
      'Wir haben deine Anmeldung erhalten.',
    );

    expect((await submit(form.slug)).status).toBe(200);
    expect(await mailsOf(form.id)).toHaveLength(1);

    // …and only now does somebody rewrite it, while the mail is still queued.
    const updated = await request(app().server)
      .put(apiPath(`/forms/${form.id}/notifications/${form.notificationId}`))
      .set(authedMutation(editor))
      .send({
        name: 'Bestätigung',
        subject: 'Anmeldung eingegangen',
        body: 'ACHTUNG: Der Jahrestagung fällt aus.',
        recipients: [{ kind: 'question', questionId: MAIL_QUESTION }],
        replyTo: null,
      });
    expect(updated.status).toBe(200);

    const delivered = await deliver();
    expect(delivered.text).toContain('Wir haben deine Anmeldung erhalten.');
    expect(delivered.text).not.toContain('fällt aus');
  });

  /**
   * The same claim on the other side of the mail: the **answer** moved, through
   * the edit route, while the confirmation was still waiting.
   *
   * A confirmation says „this is what we received from you". Rendering it against
   * the corrected answer would make it say something the participant never sent
   * at the moment it was promised — and the correction gets its own
   * confirmation anyway.
   */
  it('delivers the answer values the submission had, not the corrected ones', async () => {
    const form = await sendingForm(
      'Antwort danach geändert',
      `Hallo ${questionPlaceholderToken(NAME_QUESTION)}, danke.`,
    );

    const answered = await submit(form.slug);
    expect(answered.status).toBe(200);
    const editUrl = (answered.body as { editUrl: string | null }).editUrl;
    expect(editUrl).not.toBeNull();
    const token = (editUrl ?? '').split('/a/')[1] ?? '';
    expect(token).not.toBe('');

    const corrected = await request(app().server)
      .put(apiPath(`/public/responses/${token}`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers: { ...ANSWERS, [NAME_QUESTION]: 'Bertram Bursche' } });
    expect(corrected.status).toBe(200);
    // The correction really did land — otherwise the case below would hold for
    // the wrong reason.
    const stored = await app().prisma.response.findFirstOrThrow({
      where: { formId: form.id },
      select: { answers: true },
    });
    expect(JSON.stringify(stored.answers)).toContain('Bertram Bursche');

    const delivered = await deliver();
    expect(delivered.text).toContain('Hallo Anton Aktiv, danke.');
    expect(delivered.text).not.toContain('Bertram');
  });

  /**
   * **The answer is gone and the mail still goes out** — the case that used to
   * fail permanently.
   *
   * Before the freeze the send step needed the answer to build the text, so a
   * physically deleted response (trash purge) turned every waiting
   * confirmation into five refusals and a `failed` line. The text does not
   * depend on that row any more; what `response_id` still decides is only the
   * edit link, and `SetNull` makes it `null`, which means „no link".
   */
  it('sends a queued mail whose answer has been deleted, without the link', async () => {
    const form = await sendingForm(
      'Antwort gelöscht',
      `Hallo ${questionPlaceholderToken(NAME_QUESTION)}. Ändern: ${systemPlaceholderToken('bearbeiten')}`,
    );

    expect((await submit(form.slug)).status).toBe(200);
    const queued = await mailsOf(form.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.responseId).not.toBeNull();

    // Physical deletion, as the trash purge will do it.
    await app().prisma.response.deleteMany({ where: { formId: form.id } });

    const orphaned = await mailsOf(form.id);
    // `SetNull` kept the log line and cut the reference — that is what the
    // column does here, and the reason the mail can still be sent.
    expect(orphaned[0]?.responseId).toBeNull();
    expect(orphaned[0]?.status).toBe('queued');

    const delivered = await deliver();
    expect(delivered.text).toContain('Hallo Anton Aktiv.');
    // No link, and no leftover mark either.
    expect(delivered.text).not.toContain('/a/');
    expect(delivered.text).not.toContain(EDIT_LINK_MARK);

    const sent = await mailsOf(form.id);
    expect(sent[0]?.status).toBe('sent');
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 4–6: the one exception, `{{bearbeiten}}`
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **Asserted on the stored column, not on the delivered mail** .
   *
   * „Not resolved at the enqueue" is a statement about what is written down.
   * A test that only looked at the delivered mail would be green for an
   * implementation that resolved the link at the enqueue and stored it — which
   * is exactly the behaviour this decision rules out, because the link may have
   * been revoked by the time the mail leaves.
   */
  it('does not resolve the edit link when the row is written', async () => {
    const form = await sendingForm(
      'Link erst beim Senden',
      `Ändern: ${systemPlaceholderToken('bearbeiten')}`,
    );

    expect((await submit(form.slug)).status).toBe(200);

    const [row] = await mailsOf(form.id);
    expect(row?.bodyText).toContain(EDIT_LINK_MARK);
    // Neither the address nor the token: the whole point is that nothing
    // resolvable is frozen into the row.
    expect(row?.bodyText).not.toContain('/a/');
    expect(row?.bodyText).not.toContain(TEST_PUBLIC_BASE_URL);
    // The subject is frozen and never filled in later, so the link renders to
    // nothing there rather than to a mark that would be sent as-is.
    expect(row?.subject).toBe('Anmeldung eingegangen');
    expect(row?.subject).not.toContain(EDIT_LINK_MARK);
  });

  /**
   * …and the other half: the send step **does** fill it, with an absolute
   * address built from `PUBLIC_BASE_URL`.
   *
   * Never from the request's `Host` — there is no request behind
   * the worker at all. The token in the delivered link is compared with the one
   * on the answer row, so „some URL or other" does not pass.
   */
  it('inserts the absolute edit link when the mail is sent', async () => {
    const form = await sendingForm(
      'Link beim Senden',
      `Ändern: ${systemPlaceholderToken('bearbeiten')}`,
    );

    expect((await submit(form.slug)).status).toBe(200);
    const stored = await app().prisma.response.findFirstOrThrow({
      where: { formId: form.id },
      select: { editToken: true },
    });

    const delivered = await deliver();
    expect(delivered.text).toContain(
      `${TEST_PUBLIC_BASE_URL}/a/${stored.editToken ?? ''}`,
    );
    expect(delivered.text).not.toContain(EDIT_LINK_MARK);
  });

  /**
   * The HTML half is an **anchor**, the text half is the bare address.
   *
   * Not decoration: a bare URL in an HTML mail is only clickable if the
   * recipient's client happens to auto-link it, and the placeholder is called
   * „Bearbeiten-Link".
   */
  it('writes an anchor in HTML and the bare address in the text alternative', async () => {
    const form = await publishedForm('HTML und Text');
    await configure(
      form.id,
      { confirm: true, access: true },
      { allowEdit: true },
    );
    await addNotification(form.id, {
      name: 'Bestätigung',
      subject: 'Anmeldung eingegangen',
      body: `<p>Ändern: ${systemPlaceholderToken('bearbeiten')}</p>`,
      format: 'html',
      recipients: [{ kind: 'question', questionId: MAIL_QUESTION }],
    });

    expect((await submit(form.slug)).status).toBe(200);
    const stored = await app().prisma.response.findFirstOrThrow({
      where: { formId: form.id },
      select: { editToken: true },
    });
    const url = `${TEST_PUBLIC_BASE_URL}/a/${stored.editToken ?? ''}`;

    const delivered = await deliver();
    expect(delivered.html).toContain(`<a href="${url}">${url}</a>`);
    expect(delivered.text).toContain(url);
    expect(delivered.text).not.toContain('<a href');
  });

  /**
   * **`allowEdit` off → no link, and the rest of the text stands** (* first half).
   *
   * The ordinary case, not an edge: most forms do not offer editing at all. A
   * link that is guaranteed to answer 409 `editing_disabled` is worse than
   * none, and the sentence around it has to survive — „resolves to nothing"
   * must not become „the line falls away".
   */
  it('leaves out the link when the form does not allow editing', async () => {
    const form = await publishedForm('Bearbeiten aus');
    await configure(
      form.id,
      { confirm: true, access: true },
      { allowEdit: false },
    );
    await addNotification(form.id, {
      name: 'Bestätigung',
      subject: 'Anmeldung eingegangen',
      body: `Danke! Ändern: ${systemPlaceholderToken('bearbeiten')} Bis bald.`,
      recipients: [{ kind: 'question', questionId: MAIL_QUESTION }],
    });

    expect((await submit(form.slug)).status).toBe(200);

    const delivered = await deliver();
    // Negative: nothing that looks like an edit address, and no mark.
    expect(delivered.text).not.toContain('/a/');
    expect(delivered.text).not.toContain(EDIT_LINK_MARK);
    // Positive: the mail is still the mail.
    expect(delivered.text).toContain('Danke!');
    expect(delivered.text).toContain('Bis bald.');
  });

  /**
   * **A revoked token → no link, and the rest of the text stands** (* second half).
   *
   * Switching the access word on clears `response.edit_token` for that form
   *  — the usual reason being that a link leaked. A mail queued
   * before that must not carry the revoked address out of the building, and the
   * case is distinct from the one above: here the *setting* still says editing
   * is allowed, and only the token is gone.
   */
  it('leaves out the link when the token was revoked before the send', async () => {
    const form = await sendingForm(
      'Token widerrufen',
      `Danke! Ändern: ${systemPlaceholderToken('bearbeiten')} Bis bald.`,
    );

    expect((await submit(form.slug)).status).toBe(200);
    const issued = await app().prisma.response.findFirstOrThrow({
      where: { formId: form.id },
      select: { editToken: true },
    });
    expect(issued.editToken).not.toBeNull();

    // The access word goes on, through the real route — that is what revokes.
    await configure(
      form.id,
      { confirm: true, access: true },
      {
        allowEdit: true,
        passwordEnabled: true,
        password: 'Fuxenstall2026',
      },
    );
    const revoked = await app().prisma.response.findFirstOrThrow({
      where: { formId: form.id },
      select: { editToken: true },
    });
    expect(revoked.editToken).toBeNull();

    const delivered = await deliver();
    expect(delivered.text).not.toContain('/a/');
    expect(delivered.text).not.toContain(issued.editToken ?? 'unreachable');
    expect(delivered.text).not.toContain(EDIT_LINK_MARK);
    expect(delivered.text).toContain('Danke!');
    expect(delivered.text).toContain('Bis bald.');
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 7: what the freeze must not change
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **The mail log still carries no body** .
   *
   * The table has one now; the wire does not, and `mailLogEntrySchema` is a
   * `z.strictObject`, so a server that started sending it would make
   * `parseMailLogList` throw in the client and take the whole view down. The
   * assertion is on the **serialised payload**, not on a list of keys: a body
   * that arrived under any name, or nested anywhere, would still show up as its
   * own text.
   */
  it('does not put the body into the Versandprotokoll payload', async () => {
    const form = await sendingForm(
      'Protokoll ohne Rumpf',
      'Ein sehr wiedererkennbarer Bestätigungstext.',
    );

    expect((await submit(form.slug)).status).toBe(200);
    const [row] = await mailsOf(form.id);
    // The body really is in the table — otherwise this case would be green
    // because nothing was ever stored.
    expect(row?.bodyText).toContain('Ein sehr wiedererkennbarer');

    const listed = await request(app().server)
      .get(apiPath(`/mail-log?formId=${form.id}`))
      .set('Cookie', cookieHeader(editor));

    expect(listed.status).toBe(200);
    const payload = JSON.stringify(listed.body);
    expect(payload).toContain('Anmeldung eingegangen');
    expect(payload).not.toContain('Ein sehr wiedererkennbarer');
    expect(payload).not.toContain('bodyText');
    expect(payload).not.toContain('bodyHtml');
  });
  // ═════════════════════════════════════════════════════════════════════════
  // 8: an unreadable settings document postpones the delivery — it does not
  //    strip the link out of it
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **A settings document that cannot be read must not produce a linkless
   * mail** (ADR-0011).
   *
   * The three possibilities are not two: send without the link, postpone the
   * attempt, or never enqueue. The first is irreversible and hits every form of
   * the organisation whose document broke; the third breaks the confirmation
   * the requirement promises for an answer that has already been accepted. So
   * the attempt fails, visibly, and the queue does what it is built for.
   *
   * **Since ADR-0011 (continuation 2026-08-14) the broken document is the
   * organisation's** and no longer an installation-wide row: that one does not
   * exist any more. The rule itself — `enforcedSettings` fails, the throw is
   * postponed — is the same.
   *
   * The second half is the load-bearing one. „The mail did not go out" alone
   * would also be green for a delivery that is broken for good — which is the
   * outcome this test exists to rule out. So the row is repaired and the mail
   * then goes out **with** its link.
   */
  it('postpones the delivery while the settings do not parse, and sends it after', async () => {
    const form = await sendingForm(
      'Systemzeile unlesbar',
      'Bitte pruefen: {{bearbeiten}}',
    );
    expect((await submit(form.slug)).status).toBe(200);

    // A key that no version of this application knows — exactly what a newer
    // deployment writes and this one does not read.
    await app().prisma.tenant.update({
      where: { id: tenant.id },
      data: { formDefaults: { einstellungAusM9: true } },
    });

    try {
      const before = transport.attemptCount;
      const run = await worker.runOnce();

      // Nothing left the building.
      expect(run.sent).toBe(0);
      // At least this form's row — the queue may still hold rows from the cases
      // above, and they are under the same broken system row, so counting the
      // whole run would make this test depend on how many of them are due.
      expect(run.deferred).toBeGreaterThanOrEqual(1);
      expect(transport.attemptCount).toBe(before);

      // …and the row says why, in a sentence an editor can act on.
      const [deferredRow] = await mailsOf(form.id);
      expect(deferredRow?.status).toBe('queued');
      expect(deferredRow?.attempts).toBe(1);
      expect(deferredRow?.lastError).toBe(UNREADABLE_SETTINGS_MAIL_REASON);
      expect(deferredRow?.sentAt).toBeNull();

      // The mail log still renders while the row is broken — it is the
      // page an operator opens to find out *why*, and a 500 there would take
      // the diagnosis away. The detail route never hands out the address, so
      // degrading to „no link" costs nothing that could leave the server.
      const detail = await request(app().server)
        .get(apiPath(`/mail-log/${deferredRow?.id ?? 'unreachable'}`))
        .set('Cookie', cookieHeader(editor));
      expect(detail.status).toBe(200);
    } finally {
      // Repaired by emptying the document: `{}` is „nothing decided" and is
      // what every organisation that never saved its standards carries.
      await app().prisma.tenant.update({
        where: { id: tenant.id },
        data: { formDefaults: {} },
      });
    }

    // Repaired: past the backoff the same row goes out, link included.
    clock.advance(24 * 60 * 60 * 1000);
    const delivered = await deliver();
    expect(delivered.text).toContain('/a/');
    expect(delivered.text).not.toContain(EDIT_LINK_MARK);

    const [sentRow] = await mailsOf(form.id);
    expect(sentRow?.status).toBe('sent');
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The base address applies per organisation, with the system default beneath
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **The requirement, driven entirely through the real worker.**
   *
   * Every case above already proves the second rung of the chain — an organisation
   * without its own address falls back to the system default — because none
   * of them ever sets `tenant.public_base_url` and every one of them still
   * gets `TEST_PUBLIC_BASE_URL` in its link (e.g. „inserts the absolute edit
   * link when the mail is sent" above). What is missing is the top rung (an
   * organisation's own address overrides the system one) and the bottom one (neither
   * exists → no link, not the system default) — both here, plus the two
   * reproductions a bare unit test cannot reach: a forged `Host`, and „only
   * this organisation's mail, not the other's, in the same worker run".
   */
  describe('the base address resolves per organisation, not per session or Host', () => {
    const TENANT_A_BASE = 'https://c6-organisation-a.test.invalid';
    const TENANT_B_BASE = 'https://c6-organisation-b.test.invalid';

    interface TenantWithEditor {
      readonly tenant: TenantFixture;
      readonly editor: string;
    }

    /** A fresh organisation, with its own base address if one is given. */
    async function freshTenant(
      shortName: string,
      ownBase?: string,
    ): Promise<TenantWithEditor> {
      const created = await createTenant(app().prisma, shortName);
      if (ownBase !== undefined) {
        await app().prisma.tenant.update({
          where: { id: created.id },
          data: { publicBaseUrl: ownBase },
        });
      }
      const user = await createUser(app().prisma, {
        email: `${shortName.toLowerCase()}@example.org`,
        password: PASSWORD,
        tenants: [created],
      });
      const tenantEditor = await openSession(testApp, user.id, created.id);
      return { tenant: created, editor: tenantEditor };
    }

    /** A published, sending form of `owner` — everything `sendingForm` sets up,
     * for an organisation of its own rather than the shared fixture's. */
    async function sendingFormOf(
      owner: TenantWithEditor,
      title: string,
      body: string,
    ): Promise<Form> {
      const created = await request(app().server)
        .post(apiPath('/forms'))
        .set(authedMutation(owner.editor))
        .send({ title });
      expect(created.status).toBe(201);
      const form = created.body as {
        id: string;
        revision: number;
        publicSlug: string;
      };

      const saved = await request(app().server)
        .put(apiPath(`/forms/${form.id}`))
        .set(authedMutation(owner.editor))
        .send({ title, definition, revision: form.revision });
      expect(saved.status).toBe(200);

      const published = await request(app().server)
        .post(apiPath(`/forms/${form.id}/publish`))
        .set(authedMutation(owner.editor))
        .send({ revision: (saved.body as { revision: number }).revision });
      expect(published.status).toBe(200);

      const row = await app().prisma.form.findUniqueOrThrow({
        where: { id: form.id },
        select: { settingsRevision: true },
      });
      const tenantRow = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: owner.tenant.id },
        select: { formDefaultsRevision: true },
      });
      const settings = await request(app().server)
        .put(apiPath(`/forms/${form.id}/settings`))
        .set(authedMutation(owner.editor))
        .send({
          overridden: {
            access: true,
            confirm: true,
            display: false,
            budget: false,
          },
          values: { allowEdit: true },
          revision: row.settingsRevision,
          tenantRevision: tenantRow.formDefaultsRevision,
        });
      expect(settings.status).toBe(200);

      const notification = await request(app().server)
        .post(apiPath(`/forms/${form.id}/notifications`))
        .set(authedMutation(owner.editor))
        .send({
          name: 'Bestätigung',
          subject: 'Anmeldung eingegangen',
          body,
          recipients: [{ kind: 'question', questionId: MAIL_QUESTION }],
          replyTo: null,
        });
      expect(notification.status).toBe(201);

      return { id: form.id, slug: form.publicSlug };
    }

    /**
     * **The two-organisation test, both directions together.** Two organisations, two own
     * addresses, both submissions in flight before the worker ever runs and
     * drained in the **same** `runOnce()` — so „reads the organisation of the session"
     * cannot even coincidentally pass by both tests happening to run against
     * whichever organisation a shared session belongs to: there is no session on this
     * path at all, and there are two different, live organisations in one run to tell
     * apart. **A further probe** rides along: the submission to organisation A carries a forged
     * `Host`, and the assertion is that it changes nothing.
     */
    it('gives each organisation’s mail its own address — not the other organisation’s, not the system’s, not a forged Host', async () => {
      const tenantA = await freshTenant('C6BundA', TENANT_A_BASE);
      const tenantB = await freshTenant('C6BundB', TENANT_B_BASE);

      const formA = await sendingFormOf(
        tenantA,
        'Organisation A',
        `Ändern: ${systemPlaceholderToken('bearbeiten')}`,
      );
      const formB = await sendingFormOf(
        tenantB,
        'Organisation B',
        `Ändern: ${systemPlaceholderToken('bearbeiten')}`,
      );

      const ADDRESS_A = 'anton.a@example.invalid';
      const ADDRESS_B = 'anton.b@example.invalid';

      const submittedA = await request(app().server)
        .post(apiPath(`/public/forms/${formA.slug}/responses`))
        .set('X-Forwarded-For', ownAddress())
        .set('Host', 'angreifer.invalid')
        .send({
          answers: { [NAME_QUESTION]: 'Anton A', [MAIL_QUESTION]: ADDRESS_A },
        });
      expect(submittedA.status).toBe(200);
      const submittedB = await request(app().server)
        .post(apiPath(`/public/forms/${formB.slug}/responses`))
        .set('X-Forwarded-For', ownAddress())
        .send({
          answers: { [NAME_QUESTION]: 'Anton B', [MAIL_QUESTION]: ADDRESS_B },
        });
      expect(submittedB.status).toBe(200);

      const tokenA = await app().prisma.response.findFirstOrThrow({
        where: { formId: formA.id },
        select: { editToken: true },
      });
      const tokenB = await app().prisma.response.findFirstOrThrow({
        where: { formId: formB.id },
        select: { editToken: true },
      });

      const run = await worker.runOnce();
      expect(run.sent).toBeGreaterThanOrEqual(2);

      const mailA = transport.attempts.find((a) => a.to === ADDRESS_A);
      const mailB = transport.attempts.find((a) => a.to === ADDRESS_B);
      expect(mailA?.text).toContain(
        `${TENANT_A_BASE}/a/${tokenA.editToken ?? ''}`,
      );
      expect(mailA?.text).not.toContain(TENANT_B_BASE);
      expect(mailA?.text).not.toContain(TEST_PUBLIC_BASE_URL);
      expect(mailA?.text).not.toContain('angreifer.invalid');

      expect(mailB?.text).toContain(
        `${TENANT_B_BASE}/a/${tokenB.editToken ?? ''}`,
      );
      expect(mailB?.text).not.toContain(TENANT_A_BASE);
      expect(mailB?.text).not.toContain(TEST_PUBLIC_BASE_URL);
    });

    /**
     * **Both directions.** An organisation with no own address, and — for this one
     * case — a *system* row with none either: the chain runs out, and
     * `{{bearbeiten}}` has to resolve to nothing rather than falling back one
     * rung further than it should. Positive and negative, the same shape as
     * `frozen-mail-body.spec.ts`'s own „leaves out the link" cases above: the
     * absence of a link must not cost the rest of the sentence.
     */
    it('leaves out the link — and only the link — when neither the organisation nor the system has an address', async () => {
      const tenantWithoutBase = await freshTenant('C6BundN');
      const form = await sendingFormOf(
        tenantWithoutBase,
        'Ohne jede Adresse',
        `Danke! Ändern: ${systemPlaceholderToken('bearbeiten')} Bis bald.`,
      );
      const ADDRESS = 'anton.n@example.invalid';

      await app().prisma.systemSetting.update({
        where: { id: 'x' },
        data: { publicBaseUrl: null },
      });
      try {
        const submitted = await request(app().server)
          .post(apiPath(`/public/forms/${form.slug}/responses`))
          .set('X-Forwarded-For', ownAddress())
          .send({
            answers: { [NAME_QUESTION]: 'Anton N', [MAIL_QUESTION]: ADDRESS },
          });
        expect(submitted.status).toBe(200);

        const run = await worker.runOnce();
        expect(run.sent).toBeGreaterThanOrEqual(1);

        const mail = transport.attempts.find((a) => a.to === ADDRESS);
        // Negative: nothing resolvable, and no leftover mark.
        expect(mail?.text).not.toContain('/a/');
        expect(mail?.text).not.toContain(EDIT_LINK_MARK);
        // Positive: the rest of the sentence stands — „no link" must not
        // become „no line".
        expect(mail?.text).toContain('Danke!');
        expect(mail?.text).toContain('Bis bald.');
      } finally {
        // Restored, not merely deleted: every other case in this file relies
        // on `TEST_PUBLIC_BASE_URL` being the system default again.
        await app().prisma.systemSetting.update({
          where: { id: 'x' },
          data: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
        });
      }
    });

    /**
     * **A review finding.** The system row was already reported when it did not
     * parse (`system-settings.spec.ts`, „an unreadable row degrades the
     * display and shuts the gate"); an organisation's own column was not. An organisation that
     * mistypes its address — no `https://`, here — got no diagnosis at all:
     * every one of its mails silently carried the *installation's* address
     * from then on, indistinguishable in the log from an organisation that simply
     * never set one.
     */
    it('falls back to the system default and reports the organisation once — without the stored value — when its column is unusable', async () => {
      const INVALID_BASE = 'www.Organisation-a.de';
      const tenantWithBadBase = await freshTenant('C6BundBad', INVALID_BASE);
      const form = await sendingFormOf(
        tenantWithBadBase,
        'Ohne Schema',
        `Ändern: ${systemPlaceholderToken('bearbeiten')}`,
      );
      const ADDRESS = 'anton.bad@example.invalid';

      const capture = captureStdio();
      try {
        const submitted = await request(app().server)
          .post(apiPath(`/public/forms/${form.slug}/responses`))
          .set('X-Forwarded-For', ownAddress())
          .send({
            answers: { [NAME_QUESTION]: 'Anton Bad', [MAIL_QUESTION]: ADDRESS },
          });
        expect(submitted.status).toBe(200);

        const token = await app().prisma.response.findFirstOrThrow({
          where: { formId: form.id },
          select: { editToken: true },
        });

        const run = await worker.runOnce();
        expect(run.sent).toBeGreaterThanOrEqual(1);

        const mail = transport.attempts.find((a) => a.to === ADDRESS);
        // The chain falls through to the system default …
        expect(mail?.text).toContain(
          `${TEST_PUBLIC_BASE_URL}/a/${token.editToken ?? ''}`,
        );
        // … the invalid column never reaches a mail …
        expect(mail?.text).not.toContain(INVALID_BASE);
        // … and the failure is on record, naming the organisation but not the value.
        expect(
          capture.countOf(tenantWithBadBase.tenant.id),
        ).toBeGreaterThanOrEqual(1);
        expect(capture.text()).not.toContain(INVALID_BASE);
      } finally {
        capture.restore();
      }
    });
  });
});
