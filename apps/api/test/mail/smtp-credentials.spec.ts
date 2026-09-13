import { randomBytes } from 'node:crypto';

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MAIL_BACKOFF_MAX_MS } from '../../src/mail/mail-backoff';
import { MailWorkerService } from '../../src/mail/mail-worker.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import { createTenant, createUser } from '../support/fixtures';
import { authedMutation, cookieHeader, openSession } from '../support/http';
import { MAIL_CATEGORY_AUTH } from '../../src/mail/mail-error-category';
import { MailSecretsService } from '../../src/mail/mail-secrets.service';
import { startSmtpInbox, type SmtpInbox } from '../support/smtp-inbox';
import {
  createMailContext,
  createMailTenant,
  enqueueMail,
  resetMailTables,
  StubBodyRenderer,
  type MailContext,
} from './mail-test-context';
import { captureStdio } from './stdio-capture';

/**
 * SMTP credentials come from the environment and stay there.
 *
 * Both halves of the requirement need a **real** SMTP server, in this process:
 * the second one („ein geänderter Wert kommt an") because a test that inspects
 * the options object built from `env` proves the mapping and not the use — it
 * would stay green if `NodemailerTransport` ignored those options entirely.
 * The first one („nichts leckt") because the interesting string is the error a
 * *server* produces on a refused login, and no double can produce that.
 *
 * The listener binds to `127.0.0.1`, every address is `…@example.invalid`, and
 * no run can therefore reach a real mailbox.
 */

const SETUP_TIMEOUT_MS = 180_000;

/**
 * A secret that cannot be found by accident.
 *
 * Random per run — a fixed `secret` would either occur somewhere by chance
 * (false red) or, far worse, occur nowhere for reasons that have nothing to do
 * with the code under test (green that proves nothing). The punctuation is
 * there so the raw, base64 and percent-encoded spellings differ from each
 * other; all three are searched for, because a leak through an encoder is
 * still a leak.
 */
function mintSecret(prefix: string): string {
  return `${prefix}!${randomBytes(12).toString('hex')}+/=`;
}

/** The spellings a leaked value could take. */
function spellings(secret: string): { label: string; value: string }[] {
  return [
    { label: 'im Klartext', value: secret },
    { label: 'base64-kodiert', value: Buffer.from(secret).toString('base64') },
    { label: 'URL-kodiert', value: encodeURIComponent(secret) },
  ];
}

const C6_PAGE = '019ffb00-0000-7000-8000-0000000000a0';
const C6_NAME_QUESTION = '019ffb00-0000-7000-8000-000000000001';
const C6_OFFICE_ADDRESS = 'buero@example.invalid';

/**
 * A published form with one internal notification, filled in once — through the
 * real routes, so what lands in `mail_log` is what the route writes.
 *
 * Returns the public slug, so the caller can submit again while the mail server
 * is refusing logins.
 */
async function submittedForm(app: TestApp, session: string): Promise<string> {
  const created = await request(app.server)
    .post(apiPath('/forms'))
    .set(authedMutation(session))
    .send({ title: 'Anmeldung Jahrestagung' });
  expect(created.status).toBe(201);
  const form = created.body as {
    id: string;
    revision: number;
    publicSlug: string;
  };

  const definition = {
    pages: [
      {
        id: C6_PAGE,
        title: 'Anmeldung',
        questions: [
          {
            id: C6_NAME_QUESTION,
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

  const saved = await request(app.server)
    .put(apiPath(`/forms/${form.id}`))
    .set(authedMutation(session))
    .send({
      title: 'Anmeldung Jahrestagung',
      definition,
      revision: form.revision,
    });
  expect(saved.status).toBe(200);

  const published = await request(app.server)
    .post(apiPath(`/forms/${form.id}/publish`))
    .set(authedMutation(session))
    .send({ revision: (saved.body as { revision: number }).revision });
  expect(published.status).toBe(200);

  const notification = await request(app.server)
    .post(apiPath(`/forms/${form.id}/notifications`))
    .set(authedMutation(session))
    .send({
      name: 'Anmeldung an das Organisationsbüro',
      subject: 'Neue Anmeldung',
      body: 'Es ist eine Anmeldung eingegangen.',
      // Internal only: no question recipient, so the effective setting
      // *Bestätigung an Teilnehmer senden* stays out of this case.
      recipients: [{ kind: 'literal', address: C6_OFFICE_ADDRESS }],
      replyTo: null,
    });
  expect(notification.status).toBe(201);

  const submitted = await request(app.server)
    .post(apiPath(`/public/forms/${form.publicSlug}/responses`))
    .send({ answers: { [C6_NAME_QUESTION]: 'Anton Aktiv' } });
  expect(submitted.status).toBe(200);

  return form.publicSlug;
}

describe('SMTP credentials', () => {
  let database: TestDatabase | undefined;
  let inbox: SmtpInbox | undefined;
  let context: MailContext | undefined;

  beforeAll(async () => {
    database = await acquireTestDatabase();
  }, SETUP_TIMEOUT_MS);

  afterEach(async () => {
    await context?.close();
    context = undefined;
    await inbox?.close();
    inbox = undefined;
  });

  afterAll(async () => {
    await database?.release();
  });

  /**
   * The setup: a real catching server and the real `NodemailerTransport`. It
   * does **not** take credentials — since ADR-0023 those belong in the block
   * of the organisation, and {@link tenantWithCredentials} sets that one.
   */
  async function open(): Promise<{ ctx: MailContext; server: SmtpInbox }> {
    if (database === undefined) {
      throw new Error('no test database');
    }
    const server = await startSmtpInbox();
    inbox = server;
    context = await createMailContext({
      databaseUrl: database.url,
      // The real `NodemailerTransport`, built from exactly the block below.
      // The block is a **row** (since ADR-0023 that of the organisation,
      // because it inherits nothing any more) instead of six environment
      // variables, and the password travels sealed — precisely that also makes
      // this suite the evidence for it: what the server sees below has been
      // through the `SecretBox` and back.
      useRealTransport: true,
      renderer: new StubBodyRenderer({ text: 'Anmeldung eingegangen.' }),
      // The installation explicitly has **no** mail server: were there one, it
      // would stay open which block delivered the credentials.
      systemMail: { smtp: null },
    });
    await resetMailTables(context.prisma);
    return { ctx: context, server };
  }

  /** An organisation with **its own** mail server — with a login. */
  async function tenantWithCredentials(
    ctx: MailContext,
    port: number,
    user: string,
    password: string,
  ): Promise<string> {
    const tenantId = await createMailTenant(ctx.prisma, 'Organisation Alpha');
    await ctx.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        smtp: ctx.secrets.sealTenantBlock(
          {
            host: '127.0.0.1',
            port,
            secure: false,
            auth: { user, password: { kind: 'typed', value: password } },
            from: 'formulare@example.invalid',
          },
          tenantId,
        ),
      },
    });
    return tenantId;
  }

  it('hands the configured user and password to the mail server', async () => {
    const user = mintSecret('user');
    const password = mintSecret('pw');
    const { ctx, server } = await open();

    const tenantId = await tenantWithCredentials(
      ctx,
      server.port,
      user,
      password,
    );
    await enqueueMail(ctx.prisma, {
      tenantId,
      recipient: 'bbr@example.invalid',
      subject: 'Anmeldung eingegangen',
    });

    const run = await ctx.worker.runOnce();
    expect(run.sent).toBe(1);

    // **The server's own record, not our options object.** This is what a
    // hard-wired credential in the transport factory fails on; an assertion on
    // `createTransport`'s argument would not notice.
    expect(server.auths).toHaveLength(1);
    expect(server.auths[0]?.user).toBe(user);
    expect(server.auths[0]?.pass).toBe(password);

    // And the mail really travelled the SMTP path — subject and body arrived.
    expect(server.messages).toHaveLength(1);
    expect(server.messages[0]?.data).toContain('Anmeldung eingegangen');
    expect(server.messages[0]?.to).toEqual(['bbr@example.invalid']);
    // The organisation's display name in front of the address of its own block.
    expect(server.messages[0]?.from).toBe('formulare@example.invalid');
  });

  it('leaks neither user nor password into logs or the mail log', async () => {
    const user = mintSecret('user');
    const password = mintSecret('pw');

    // Armed before the transport is built, so the capture spans the whole
    // cycle the requirement names: queueing, sending, failing and retrying.
    const capture = captureStdio();
    let dumped: { row: string }[] | undefined;
    try {
      const { ctx, server } = await open();
      const tenantId = await tenantWithCredentials(
        ctx,
        server.port,
        user,
        password,
      );

      // 1. queued and sent
      await enqueueMail(ctx.prisma, {
        tenantId,
        recipient: 'zugestellt@example.invalid',
      });
      expect((await ctx.worker.runOnce()).sent).toBe(1);

      // 2. the mail server starts refusing the login: a real 535, produced by
      //    a real server, with our credentials in flight.
      server.refuseLogins(true);
      await enqueueMail(ctx.prisma, {
        tenantId,
        recipient: 'abgelehnt@example.invalid',
      });
      expect((await ctx.worker.runOnce()).deferred).toBe(1);

      // 3. and retried, so the reason is written a second time
      ctx.clock.advance(MAIL_BACKOFF_MAX_MS + 60_000);
      expect((await ctx.worker.runOnce()).deferred).toBe(1);

      // Every column of every row, not just the ones the view shows.
      dumped = await ctx.prisma.$queryRaw<
        { row: string }[]
      >`SELECT to_jsonb(m)::text AS "row" FROM "mail_log" m`;
    } finally {
      capture.restore();
    }

    const output = capture.text();
    const rows = dumped.map((entry) => entry.row).join('\n');

    expect(rows).toContain('abgelehnt@example.invalid');
    expect(rows.length).toBeGreaterThan(0);

    for (const secret of [password, user]) {
      for (const { label, value } of spellings(secret)) {
        expect(output, `Zugangsdaten ${label} im Log`).not.toContain(value);
        expect(rows, `Zugangsdaten ${label} in mail_log`).not.toContain(value);
      }
    }
  });

  /**
   * **…and not into the API's answer either** — the third place the requirement
   * names („in keiner API-Antwort"), and the one the two cases above cannot
   * reach.
   *
   * They search `stdout`/`stderr` and every column of every `mail_log` row.
   * Neither says anything about what the *server hands out*: `last_error`
   * travels to the browser, `toEntry` picks the fields by hand, and a widened
   * `select` in `ScopedMailLogDelegate` would change the payload without
   * touching a column. The specification asks for „die **ganze** Nutzlast
   * jeder Protokoll-Antwort", so the whole JSON body is searched — not the
   * fields the view happens to render.
   *
   * A full application here rather than the narrow `MailModule` harness: there
   * is no payload without the route, and the route only exists behind the guard
   * chain.
   */
  it('leaks neither user nor password into the Versandprotokoll payload', async () => {
    if (database === undefined) {
      throw new Error('no test database');
    }
    const user = mintSecret('user');
    const password = mintSecret('pw');

    const server = await startSmtpInbox();
    inbox = server;
    let app: TestApp | undefined;
    try {
      app = await createTestApp({
        databaseUrl: database.url,
        // The installation has no mail server — the block this is about
        // belongs to the organisation (ADR-0023).
        systemMail: { smtp: null },
      });
      const tenant = await createTenant(app.prisma, 'MAILC6');
      // The real `NodemailerTransport`, built from exactly this stored block.
      await app.prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          smtp: app.app.get(MailSecretsService).sealTenantBlock(
            {
              host: '127.0.0.1',
              port: server.port,
              secure: false,
              auth: { user, password: { kind: 'typed', value: password } },
              from: 'formulare@example.invalid',
            },
            tenant.id,
          ),
        },
      });
      const editor = await createUser(app.prisma, {
        email: 'protokoll@example.org',
        password: 'test-password',
        tenants: [tenant],
      });
      const session = await openSession(app, editor.id, tenant.id);
      // A real submission, so the queued rows are the ones the route writes: the body
      // is rebuilt at send time from the notification and the answer, and a
      // hand-written row without either fails *before* the transport — the run
      // would then never carry the credentials at all.
      const slug = await submittedForm(app, session);

      // The line goes out …
      expect((await app.app.get(MailWorkerService).runOnce()).sent).toBe(1);

      // … and the next one is refused, so a real 535 — produced by a real
      // server, with our credentials in flight — becomes `last_error` and
      // travels to the client. Since ADR-0023 this organisation sends through
      // its **own** block, so the reason is the category and not the wording
      // of the server (`queueReasonStyle`) — which makes this assertion
      // sharper instead of weaker: it gets to see the result of a real 535
      // without the response reproducing it.
      server.refuseLogins(true);
      await request(app.server)
        .post(apiPath(`/public/forms/${slug}/responses`))
        .send({ answers: { [C6_NAME_QUESTION]: 'Bertha Mitglied' } })
        .expect(200);
      expect((await app.app.get(MailWorkerService).runOnce()).deferred).toBe(1);

      const listed = await request(app.server)
        .get(apiPath('/mail-log'))
        .set('Cookie', cookieHeader(session));
      expect(listed.status).toBe(200);

      const payload = JSON.stringify(listed.body);
      // The payload really carries a queued *and* a refused line — otherwise
      // „nichts gefunden" would be the answer of a response that says nothing.
      expect(payload).toContain(C6_OFFICE_ADDRESS);
      // The beginning of the sentence, not the whole one: the payload is JSON,
      // and the typographic quotation marks in it are escaped.
      expect(payload).toContain(MAIL_CATEGORY_AUTH.split('.')[0]);
      // And the wording of the server is **not** in it.
      expect(payload).not.toContain('535');

      for (const secret of [password, user]) {
        for (const { label, value } of spellings(secret)) {
          expect(
            payload,
            `Zugangsdaten ${label} in der Protokoll-Antwort`,
          ).not.toContain(value);
        }
      }
    } finally {
      await app?.close();
    }
  });
});
