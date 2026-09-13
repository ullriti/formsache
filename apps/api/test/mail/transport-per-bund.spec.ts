import { randomBytes } from 'node:crypto';

import { ConsoleLogger } from '@nestjs/common';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { MAIL_CONFIG_UNPARSABLE_REASON } from '../../src/mail/mail-secrets.service';
import { MAIL_CATEGORY_UNREACHABLE } from '../../src/mail/mail-error-category';
import type { ClaimedMail } from '../../src/mail/mail-queue.repository';
import { SYSTEM_IDENTITY_KEY } from '../../src/mail/mail-transport';
import { MAIL_CONFIG_BROKEN_STARTUP_ERROR } from '../../src/mail/mail-worker.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { IdentityRoutingDouble } from './identity-routing-double';
import {
  createMailContext,
  createMailTenant,
  enqueueMail,
  MAIL_TEST_EPOCH,
  resetMailTables,
  type MailContext,
} from './mail-test-context';
import { captureStdio } from './stdio-capture';

/**
 * **One transport per organisation, and one organisation's dead mail server is one organisation's
 * problem** (ADR-0013 no. 7).
 *
 * ## What each case here is the only proof of
 *
 * 1. **Two Organisationen, one hanging.** The measurement is an *overlap*: Organisation Beta's
 *    mail is handed over while Organisation Alpha's send is still parked at a barrier,
 *    inside the **same** `runOnce()`. With the queue worked as one sequential
 *    loop — the shape before this package — Beta's mail waits for Alpha's send
 *    deadline, and the case fails on exactly that.
 * 2. **A broken system block does not stop the installation.** It used to:
 *    `transport.configured()` stood outside every `try` at the top of `runOnce`,
 *    so an unreadable stored block rejected the run before a single row was
 *    claimed — for **every** Organisation, without a `last_error`, without a `failed`,
 *    visible only in a log. Since ADR-0023 a broken system block only hits
 *    the **system lane** any more; its rows go `failed` with a readable
 *    reason, and the organisations send over their own servers in the same
 *    run.
 * 3. **A lost `smtp` column is a defect, not „keine Konfiguration".** The
 *    most expensive silence of this stage: a missing column reads like an
 *    empty one, and since ADR-0023 that means „diese Organisation sendet
 *    nicht" — its queue would stand still forever, with a reason that is not
 *    true, and **nothing would turn red**, because `withhold` is a
 *    permissible state.
 * 4. **The startup line for a broken block.** The notice swallowed every
 *    exception, so the one state it exists for was the one it stayed silent
 *    about.
 *
 * The transport is a double **that works**, and its counters are per identity —
 * see `identity-routing-double.ts`. „Die Mail ging nicht raus" is green when the
 * fallback is broken too; what is asserted below is always a counter.
 */

const SETUP_TIMEOUT_MS = 180_000;

/**
 * How long Organisation Beta is given to get its mail out while Alpha is parked.
 *
 * Generous against a slow machine and far below the point at which „waited for
 * the other organisation" could pass for „was merely slow": Beta only has to claim one
 * row and hand one mail to an in-memory double.
 */
const OVERLAP_BUDGET_MS = 3_000;

const ALPHA_RECIPIENT = 'alpha@example.invalid';
const BETA_RECIPIENT = 'beta@example.invalid';
const INHERITING_RECIPIENT = 'erbt@example.invalid';

describe('one transport per organisation ', () => {
  let database: TestDatabase | undefined;
  let context: MailContext | undefined;

  beforeAll(async () => {
    database = await acquireTestDatabase();
  }, SETUP_TIMEOUT_MS);

  afterEach(async () => {
    vi.restoreAllMocks();
    // Closing the module empties the transport cache as well — without it,
    // test *n+1* would send over test *n*'s remote.
    await context?.close();
    context = undefined;
  });

  afterAll(async () => {
    await database?.release();
  });

  function url(): string {
    if (database === undefined) {
      throw new Error('no test database');
    }
    return database.url;
  }

  async function open(double: IdentityRoutingDouble): Promise<MailContext> {
    context = await createMailContext({
      databaseUrl: url(),
      transport: double,
    });
    await resetMailTables(context.prisma);
    return context;
  }

  /** An organisation that sends over its **own** mail server. */
  async function ownBlock(
    ctx: MailContext,
    tenantId: string,
    host: string,
    // A bare IP is a perfectly good SMTP host and a poor mail domain, so the
    // two are separate parameters rather than one derived from the other.
    from = `post@${host}`,
  ): Promise<void> {
    await ctx.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        smtp: ctx.secrets.sealTenantBlock(
          {
            host,
            port: 587,
            secure: false,
            from,
            auth: {
              user: 'Organisation',
              password: {
                kind: 'typed',
                value: `pw-${randomBytes(6).toString('hex')}`,
              },
            },
          },
          tenantId,
        ),
      },
    });
  }

  /** Polls a condition without sleeping through the whole budget. */
  async function within(
    budgetMs: number,
    condition: () => boolean,
  ): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (condition()) {
        return true;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10).unref();
      });
    }
    return condition();
  }

  // -------------------------------------------------------------------------
  // the evidence — a hanging Organisation does not hold up the others
  // -------------------------------------------------------------------------

  it('delivers one organisation’s mail while another organisation’s server hangs, in the same run', async () => {
    const double = new IdentityRoutingDouble();
    const ctx = await open(double);

    const alpha = await createMailTenant(ctx.prisma, 'Organisation Alpha');
    const beta = await createMailTenant(ctx.prisma, 'Organisation Beta');
    await ownBlock(ctx, alpha, 'mail.alpha.invalid');
    await ownBlock(ctx, beta, 'mail.beta.invalid');

    // Alpha's row is the **older** one, so a sequential worker reaches it first
    // and parks there. Without distinct instants the case could pass by picking
    // Beta first, which would prove nothing at all.
    await enqueueMail(ctx.prisma, {
      tenantId: alpha,
      recipient: ALPHA_RECIPIENT,
      createdAt: new Date(MAIL_TEST_EPOCH.getTime() - 2_000),
    });
    await enqueueMail(ctx.prisma, {
      tenantId: beta,
      recipient: BETA_RECIPIENT,
      createdAt: new Date(MAIL_TEST_EPOCH.getTime() - 1_000),
    });

    const gate = double.hold(alpha);
    const run = ctx.worker.runOnce();
    await gate.arrived;

    // **The measurement.** Alpha is inside its send, still holding its row and
    // its place in the run; Beta's mail has to get out anyway.
    const overlapped = await within(
      OVERLAP_BUDGET_MS,
      () => double.attemptsFor(beta).length === 1,
    );
    gate.release();
    const result = await run;

    expect(overlapped, 'Beta wartete auf Alphas Zustellversuch').toBe(true);
    // …and it was the *same* run, not a second one: both rows are counted here.
    expect(result).toMatchObject({ attempted: 2, sent: 2, failed: 0 });

    // Each organisation used its own remote — the transports really are separate.
    expect(double.attemptsFor(alpha).map((mail) => mail.to)).toEqual([
      ALPHA_RECIPIENT,
    ]);
    expect(double.attemptsFor(beta).map((mail) => mail.to)).toEqual([
      BETA_RECIPIENT,
    ]);
    expect(double.sendersFor(beta)).toEqual(['post@mail.beta.invalid']);
    // And neither of them borrowed the installation's identity.
    expect(double.attemptsFor(SYSTEM_IDENTITY_KEY)).toHaveLength(0);

    expect(await ctx.prisma.mailLog.count({ where: { status: 'sent' } })).toBe(
      2,
    );
  });

  // -------------------------------------------------------------------------
  // The Review finding: one broken block must not stop the whole queue
  // -------------------------------------------------------------------------

  it('keeps the queue running for everybody when the system block is unreadable', async () => {
    // **The real transport, and that is the whole point of this case.** The
    // finding is that `transport.configured()` *throws* on an unreadable block,
    // and a double answers `true` unconditionally — a probe against one would
    // stay green with the old code restored, which is the worst kind of
    // reproduction. The timeouts are compressed so the own block's unresolvable
    // host is refused in milliseconds rather than in the shipped fifteen
    // seconds; only their relative order carries meaning (`mail-timeouts.ts`).
    context = await createMailContext({
      databaseUrl: url(),
      useRealTransport: true,
      timeouts: {
        connectionMs: 300,
        greetingMs: 300,
        socketMs: 300,
        sendMs: 2_000,
        claimTransactionMs: 20_000,
        claimMaxWaitMs: 20_000,
      },
    });
    const ctx = context;
    await resetMailTables(ctx.prisma);

    const own = await createMailTenant(
      ctx.prisma,
      'Organisation mit eigenem Server',
    );
    await ownBlock(ctx, own, 'mail.eigen.invalid');
    // Since ADR-0023 the **system lane** is the only one that reads the
    // installation's block at all any more — so the only one a broken system
    // block can hit. The row still needs an organisation
    // (`mail_log.tenant_id` is NOT NULL); which one decides nothing.
    const systemSide = await createMailTenant(
      ctx.prisma,
      'Organisation mit Systempost',
    );

    // A half-filled system block — a state no route can produce, so a raw write
    // is the only way it exists.
    await ctx.prisma
      .$executeRaw`UPDATE "system_setting" SET smtp = '{"host":"mail.kaputt.invalid"}'::jsonb`;

    await enqueueMail(ctx.prisma, {
      tenantId: systemSide,
      trigger: 'system',
      recipient: INHERITING_RECIPIENT,
      createdAt: new Date(MAIL_TEST_EPOCH.getTime() - 2_000),
    });
    const ownRow = await enqueueMail(ctx.prisma, {
      tenantId: own,
      recipient: ALPHA_RECIPIENT,
      createdAt: new Date(MAIL_TEST_EPOCH.getTime() - 1_000),
    });

    // **It does not reject, and it claims rows.** That is the finding: this
    // question used to be asked at the top of `runOnce`, outside every `try`, so
    // an unreadable block threw before a single row was claimed and `tick()`
    // swallowed it — one broken block, and the whole installation's queue stood
    // still, for every organisation, without one row saying why.
    const run = await ctx.worker.runOnce();
    expect(run).toMatchObject({ attempted: 2, failed: 1, deferred: 1 });

    // The system row learns what is broken, on its own row …
    const withInherited = await ctx.prisma.mailLog.findFirstOrThrow({
      where: { tenantId: systemSide },
    });
    expect(withInherited.status).toBe('failed');
    expect(withInherited.lastError).toBe(MAIL_CONFIG_UNPARSABLE_REASON);
    // **And it burnt no attempt.** No transport was asked — the block did not
    // parse — so counting one would claim a delivery was tried, and the
    // mail log would show „1 von 5 Versuchen" for a mail server nobody
    // ever dialled (ADR-0013 no. 5, third row). The `fail` arm has always been
    // written that way; until now nothing said so (a review finding).
    expect(withInherited.attempts).toBe(0);

    // … and the organisation with its own mail server got its attempt in the same run:
    // its host does not resolve, so it is deferred rather than delivered, but
    // the installation's broken block did not cost it the try.
    const attempted = await ctx.prisma.mailLog.findUniqueOrThrow({
      where: { id: ownRow },
    });
    expect(attempted.status).toBe('queued');
    expect(attempted.attempts).toBe(1);
    expect(attempted.lastError).toBe(MAIL_CATEGORY_UNREACHABLE);
  });

  // -------------------------------------------------------------------------
  // The silent forgery: a claim that lost `t."smtp"`
  // -------------------------------------------------------------------------

  /**
   * The two shapes a lost column has, and both have to be refused.
   *
   * `delete` leaves the key out; the spread with `undefined` leaves it in place
   * with nothing in it — and that is the **commoner** of the two, because it is
   * what somebody writes to „clear" a field. A guard that only asks `'tenantSmtp'
   * in row` waves it straight through into „kein Mailserver" (a review
   * finding), which is the forgery of ADR-0013 no. 2 with an extra step.
   */
  const NARROWED: readonly {
    readonly name: string;
    readonly narrow: (row: ClaimedMail) => ClaimedMail;
  }[] = [
    {
      name: 'a projection that dropped the column',
      narrow: (row) => {
        const narrowed: Record<string, unknown> = { ...row };
        delete narrowed.tenantSmtp;
        return narrowed as unknown as ClaimedMail;
      },
    },
    {
      name: 'a spread that set the column to undefined',
      narrow: (row) =>
        ({ ...row, tenantSmtp: undefined }) as unknown as ClaimedMail,
    },
  ];

  it.each(NARROWED)(
    'refuses to send a row whose Organisation’s smtp column never arrived — $name',
    async ({ narrow }) => {
      const double = new IdentityRoutingDouble();
      const ctx = await open(double);

      const own = await createMailTenant(
        ctx.prisma,
        'Organisation mit eigenem Server',
      );
      await ownBlock(ctx, own, 'mail.eigen.invalid');
      const id = await enqueueMail(ctx.prisma, {
        tenantId: own,
        recipient: ALPHA_RECIPIENT,
      });

      // The mistake this guards against is not malice, it is a `select`
      // somebody narrowed. A missing value and `null` resolve to the same arm,
      // so **without the guard this case would stay green while the row is
      // held back forever** — with a reason that is not true, and without
      // anything turning red anywhere.
      const claim = ctx.repository.claim.bind(ctx.repository);
      vi.spyOn(ctx.repository, 'claim').mockImplementation(
        async (tx, now, tenantId) => {
          const row = await claim(tx, now, tenantId);
          return row === null ? null : narrow(row);
        },
      );

      // Loud, because it is a defect and not a mail problem — and loud all the
      // way out: it is the one thing that still ends a whole run.
      await expect(ctx.worker.runOnce()).rejects.toThrow(/smtp column/);

      // **The counter that carries the case.** Not „the mail failed" — a mail
      // sent under the wrong identity does not fail.
      expect(double.attemptsFor(SYSTEM_IDENTITY_KEY)).toHaveLength(0);
      expect(double.attemptsFor(own)).toHaveLength(0);
      const untouched = await ctx.prisma.mailLog.findUniqueOrThrow({
        where: { id },
      });
      expect(untouched.status).toBe('queued');
      expect(untouched.attempts).toBe(0);
    },
  );

  it('refuses both shapes at the resolution itself, not only at the queue', async () => {
    const ctx = await open(new IdentityRoutingDouble());
    const own = await createMailTenant(
      ctx.prisma,
      'Organisation mit eigenem Server',
    );
    await ownBlock(ctx, own, 'mail.eigen.invalid');

    // **At the bottleneck, not at the caller.** The guard used to live in
    // `MailWorkerService`, which was true of the one caller that existed and
    // false of the second the moment the Testmail arrived — a new caller does
    // not inherit a check that sits in somebody else's method
    // (a security finding). Both calls below type-check only through a
    // cast, which is the point: the shapes exist at run time, not in the type.
    const resolve = (tenant: unknown): Promise<unknown> =>
      ctx.identities.resolve(
        tenant as Parameters<typeof ctx.identities.resolve>[0],
        // The organisation arm is the one whose missing column is checked
        // here; the system arm does not read it at all (ADR-0020).
        'tenant',
      );

    // The key is absent …
    await expect(resolve({ id: own })).rejects.toThrow(/smtp column/);
    // … and the key is there with nothing in it. Both would otherwise read
    // like an empty column — since ADR-0023 therefore like „diese Organisation
    // hat keinen Mailserver", and the queue would stand still with a reason
    // that is not true.
    await expect(resolve({ id: own, smtp: undefined })).rejects.toThrow(
      /smtp column/,
    );

    // And the ordinary answer stays one: `null` is „kein Mailserver", so
    // `withhold` — **never** the installation's block.
    await expect(resolve({ id: own, smtp: null })).resolves.toMatchObject({
      kind: 'withhold',
    });
  });

  // -------------------------------------------------------------------------
  // The category, not the transcript (a security finding)
  // -------------------------------------------------------------------------

  it('tells an organisation what to fix without telling it which ports are open', async () => {
    const double = new IdentityRoutingDouble();
    const ctx = await open(double);

    const own = await createMailTenant(
      ctx.prisma,
      'Organisation mit eigenem Server',
    );
    // An organisation's admin may name any host and port — including one
    // inside the server's own network. The reason travels back to that admin.
    await ownBlock(ctx, own, '127.0.0.1', 'post@organisation.invalid');
    double.refuse(own);
    const id = await enqueueMail(ctx.prisma, {
      tenantId: own,
      recipient: ALPHA_RECIPIENT,
    });

    await ctx.worker.runOnce();

    const row = await ctx.prisma.mailLog.findUniqueOrThrow({ where: { id } });
    // Readable and actionable …
    expect(row.lastError).toBe(MAIL_CATEGORY_UNREACHABLE);
    // … and *not* the remote's transcript: „ECONNREFUSED" against a timeout
    // against a protocol error is what tells an open port from a closed one.
    expect(row.lastError).not.toContain('ECONNREFUSED');
    expect(row.lastError).not.toContain('127.0.0.1');
  });

  // -------------------------------------------------------------------------
  // The startup line the notice used to swallow
  // -------------------------------------------------------------------------

  it('says at startup that the stored block is unreadable', async () => {
    // A first boot only to reach the database; the row has to be broken
    // *before* the boot whose startup line is counted.
    const seed = await createMailContext({ databaseUrl: url() });
    try {
      await resetMailTables(seed.prisma);
      await seed.prisma
        .$executeRaw`UPDATE "system_setting" SET smtp = '{"host":"mail.kaputt.invalid"}'::jsonb`;
    } finally {
      await seed.close();
    }

    const capture = captureStdio();
    try {
      context = await createMailContext({
        databaseUrl: url(),
        // The real transport, so „unlesbar" is decided by the real parse …
        useRealTransport: true,
        // … and a real logger, because `@nestjs/testing` installs one whose
        // `warn` and `log` are empty methods (see `mail-unconfigured.spec.ts`).
        logger: new ConsoleLogger(),
      });
    } finally {
      capture.restore();
    }

    // Before the fix this was the silent case: `warnIfUnconfigured` caught
    // everything, so an installation with a broken block got **no** line at all
    // — not even the „kein Mailserver konfiguriert" one, which would at least
    // have been a hint.
    expect(capture.text()).toContain(MAIL_CONFIG_BROKEN_STARTUP_ERROR);
  });
});
