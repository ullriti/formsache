import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  MailBodyRenderer,
  type RenderedMailBody,
} from '../../src/mail/mail-body-renderer';
import { MAIL_CATEGORY_REJECTED } from '../../src/mail/mail-error-category';
import { TENANT_MAIL_NOT_CONFIGURED_REASON } from '../../src/mail/mail-transport';
import {
  MAIL_RENDER_FAILED_REASON,
  MAIL_WORKER_BATCH_MAX,
  MAIL_WORKER_LANE_BATCH_MAX,
  MAIL_WORKER_TENANT_LANES,
} from '../../src/mail/mail-worker.service';
import { DB_POOL_MAX } from '../../src/prisma/prisma.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { SmtpDouble } from '../support/smtp-double';
import {
  createMailContext,
  createMailTenant,
  enqueueMail,
  resetMailTables,
  type MailContext,
} from './mail-test-context';

/**
 * **What one run costs everybody else** — the four findings of a review
 * that are about the shape of a run rather than about a row.
 *
 * Each case here measures a *call*, not a column, and that is unusual enough to
 * say why: the failures behind them are all invisible in the data. A stamping
 * statement inside the wrong transaction writes the same rows as one outside it;
 * a run that swallowed its lanes' work writes the same rows as one that kept it,
 * only the number it reports differs; and „once per run" and „once per row" are
 * the same query with different multiplicity.
 */

const SETUP_TIMEOUT_MS = 180_000;
const CASE_TIMEOUT_MS = 60_000;

/** A renderer that always refuses — the two cases differ only in how. */
class ThrowingRenderer extends MailBodyRenderer {
  constructor(private readonly error: Error) {
    super();
  }

  render(): Promise<RenderedMailBody> {
    return Promise.reject(this.error);
  }
}

describe('what one mail run costs the others', () => {
  let database: TestDatabase | undefined;
  let context: MailContext | undefined;

  beforeAll(async () => {
    database = await acquireTestDatabase();
  }, SETUP_TIMEOUT_MS);

  afterEach(async () => {
    vi.restoreAllMocks();
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

  /** A harness with a working double, unless the case wants otherwise. */
  async function open(
    options: {
      readonly unconfigured?: boolean;
      readonly stallMs?: number;
    } = {},
  ): Promise<MailContext> {
    const ctx = await createMailContext({
      databaseUrl: url(),
      transport: new SmtpDouble(
        options.stallMs === undefined ? {} : { stallMs: options.stallMs },
      ),
      // The **explicit** opt-out: a double *and* no mail server, which is
      // the only way to reach the „withhold" arm with counters to read.
      ...(options.unconfigured === true ? { systemMail: { smtp: null } } : {}),
      ...(options.stallMs === undefined
        ? {}
        : {
            timeouts: {
              sendMs: 300,
              claimTransactionMs: 8_000,
              claimMaxWaitMs: 8_000,
            },
          }),
    });
    context = ctx;
    await resetMailTables(ctx.prisma);
    return ctx;
  }

  /** A harness whose body renderer always refuses, with `error`. */
  async function openWithRenderer(error: Error): Promise<MailContext> {
    const ctx = await createMailContext({
      databaseUrl: url(),
      transport: new SmtpDouble(),
      renderer: new ThrowingRenderer(error),
    });
    context = ctx;
    await resetMailTables(ctx.prisma);
    return ctx;
  }

  /** An organisation that sends over its **own** mail server. */
  async function ownBlock(ctx: MailContext, tenantId: string): Promise<void> {
    await ctx.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        smtp: ctx.secrets.sealTenantBlock(
          {
            host: 'mail.eigen.invalid',
            port: 587,
            secure: false,
            from: 'post@eigen.invalid',
            auth: {
              user: 'Organisation',
              password: { kind: 'typed', value: 'pw-eigen-block' },
            },
          },
          tenantId,
        ),
      },
    });
  }

  /**
   * Whether **nobody** holds a row of this organisation at this instant.
   *
   * `FOR UPDATE NOWAIT` on a connection of its own: it either takes every lock
   * at once and answers, or Postgres refuses with `55P03`. That is the whole
   * measurement — „die Stempelung läuft außerhalb der Claim-Transaktion"
   * is not observable in any column, but „in dem Moment hält niemand mehr eine
   * Zeile" is.
   */
  async function nothingLocked(
    prisma: PrismaService,
    tenantId: string,
  ): Promise<boolean> {
    try {
      await prisma.$queryRaw`
        SELECT "id" FROM "mail_log"
         WHERE "tenant_id" = ${tenantId}::uuid
           FOR UPDATE NOWAIT`;
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // The cross-row stamping runs after the claim transaction, not inside it
  // -------------------------------------------------------------------------

  it(
    'stamps an organisation’s waiting rows only once its claim transaction has let go',
    async () => {
      const ctx = await open({ unconfigured: true });
      // **Without a mail server of its own**, explicitly: since ADR-0023 that is
      // the state that withholds — no longer „die Installation hat keinen".
      const tenantId = await createMailTenant(
        ctx.prisma,
        'Organisation Alpha',
        null,
      );
      for (let row = 0; row < 3; row += 1) {
        await enqueueMail(ctx.prisma, { tenantId });
      }

      /** One entry per stamping, `true` when no row was held at that moment. */
      const freeWhenStamping: boolean[] = [];
      const withholdOthers = ctx.repository.withholdOthers.bind(ctx.repository);
      vi.spyOn(ctx.repository, 'withholdOthers').mockImplementation(
        async (lane, exceptId, reason) => {
          // **The assertion, taken at the only moment it is decidable.** With
          // the statement back inside the claim transaction — the shape that
          // deadlocked two worker instances against each other — the claimed row
          // is still locked here and this answers `false`. Reproduced exactly
          // so while writing this case: `[false, true]`, red.
          //
          // Every call, not the last one: an extra invocation from inside the
          // transaction would otherwise be overwritten by the one after it.
          //
          // The lane of this case is that of an organisation — it enqueues
          // three ordinary rows —, and the lock test asks for its identifier. A
          // system lane would have none (`MailLaneKey`).
          expect(lane.kind).toBe('tenant');
          freeWhenStamping.push(
            await nothingLocked(
              ctx.prisma,
              lane.kind === 'tenant' ? lane.tenantId : '',
            ),
          );
          return withholdOthers(lane, exceptId, reason);
        },
      );

      const run = await ctx.worker.runOnce();

      expect(freeWhenStamping, 'die Claim-Transaktion hielt noch').toEqual([
        true,
      ]);
      // And the outcome itself is unchanged: every waiting row learns why, none
      // of them is `failed`, none of them burnt an attempt (ADR-0013 no. 5).
      expect(run).toMatchObject({ attempted: 0, withheld: 3, laneFailures: 0 });
      const rows = await ctx.prisma.mailLog.findMany({ where: { tenantId } });
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.status).toBe('queued');
        expect(row.attempts).toBe(0);
        expect(row.lastError).toBe(TENANT_MAIL_NOT_CONFIGURED_REASON);
      }

      // Twice is not twice as much: rows that already carry the reason are not
      // counted again, which is what makes `withheld` readable at all.
      expect((await ctx.worker.runOnce()).withheld).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // The identity is resolved before any transaction, once per run
  // -------------------------------------------------------------------------

  it(
    'resolves every sending identity before the first claim — one per lane',
    async () => {
      const ctx = await open();
      const first = await createMailTenant(ctx.prisma, 'Organisation Alpha');
      const second = await createMailTenant(ctx.prisma, 'Organisation Beta');
      for (const tenantId of [first, second]) {
        for (let row = 0; row < 3; row += 1) {
          await enqueueMail(ctx.prisma, { tenantId });
        }
      }

      const order: string[] = [];
      const resolve = ctx.identities.resolve.bind(ctx.identities);
      vi.spyOn(ctx.identities, 'resolve').mockImplementation(
        async (tenant, source) => {
          order.push('resolve');
          return resolve(tenant, source);
        },
      );
      const claim = ctx.repository.claim.bind(ctx.repository);
      vi.spyOn(ctx.repository, 'claim').mockImplementation(
        async (tx, now, tenantId) => {
          order.push('claim');
          return claim(tx, now, tenantId);
        },
      );

      const run = await ctx.worker.runOnce();
      expect(run).toMatchObject({ attempted: 6, sent: 6 });

      // **Not one resolution inside a transaction.** The claim is what opens
      // one, so „every resolve happens before every claim" is the property that
      // keeps a lane at one database connection instead of two — see the
      // arithmetic on `MAIL_WORKER_TENANT_LANES`.
      expect(order.lastIndexOf('resolve')).toBeLessThan(order.indexOf('claim'));
      // Two organisations, six rows, **two** resolutions: one per lane, not one
      // per row. Since ADR-0023 no organisation shares the answer of another one
      // any more — each has its own mail server —, and what counts is still that
      // it is **not** one per row: that was, per row, a read of the system
      // settings on a second connection.
      expect(order.filter((step) => step === 'resolve')).toHaveLength(2);
    },
    CASE_TIMEOUT_MS,
  );

  it('keeps the worker’s lanes within half the connection pool', () => {
    // The arithmetic of `MAIL_WORKER_TENANT_LANES`, asserted rather than only
    // written down: one connection per lane, and never more than half the pool,
    // so ordinary requests still have theirs. Raising the lanes without raising
    // the pool turns this red.
    expect(MAIL_WORKER_TENANT_LANES).toBeGreaterThan(1);
    expect(MAIL_WORKER_TENANT_LANES * 2).toBeLessThanOrEqual(DB_POOL_MAX);
    // And a lane's share of a run is a share, not the whole thing.
    expect(MAIL_WORKER_LANE_BATCH_MAX).toBeLessThan(MAIL_WORKER_BATCH_MAX);
    expect(
      MAIL_WORKER_LANE_BATCH_MAX * MAIL_WORKER_TENANT_LANES,
    ).toBeGreaterThanOrEqual(MAIL_WORKER_BATCH_MAX);
  });

  // -------------------------------------------------------------------------
  // A lane that breaks does not discard what the others delivered
  // -------------------------------------------------------------------------

  it(
    'reports what the working lanes sent when another lane breaks',
    async () => {
      const ctx = await open();
      const healthy = await createMailTenant(ctx.prisma, 'Organisation Alpha');
      const broken = await createMailTenant(ctx.prisma, 'Organisation Beta');
      await enqueueMail(ctx.prisma, { tenantId: healthy });
      await enqueueMail(ctx.prisma, { tenantId: broken });

      const claim = ctx.repository.claim.bind(ctx.repository);
      vi.spyOn(ctx.repository, 'claim').mockImplementation(
        async (tx, now, tenantId) => {
          if (tenantId === broken) {
            // Not a mail problem and not a configuration state: the shape of a
            // transaction that ran out of budget or a pool that was exhausted.
            throw new Error('Transaction API error: P2028');
          }
          return claim(tx, now, tenantId);
        },
      );

      // **It answers.** It used to reject — after the healthy lane had already
      // committed its send — so a run that delivered was reported as „failed"
      // with zero sent, and the counters were thrown away with the exception.
      const run = await ctx.worker.runOnce();
      expect(run).toMatchObject({
        attempted: 1,
        sent: 1,
        failed: 0,
        laneFailures: 1,
      });
      expect(ctx.double?.attemptCount).toBe(1);

      const delivered = await ctx.prisma.mailLog.findFirstOrThrow({
        where: { tenantId: healthy },
      });
      expect(delivered.status).toBe('sent');
      // The broken lane's row is exactly as it was found — the next run has it.
      const untouched = await ctx.prisma.mailLog.findFirstOrThrow({
        where: { tenantId: broken },
      });
      expect(untouched.status).toBe('queued');
      expect(untouched.attempts).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // One organisation cannot spend the whole run
  // -------------------------------------------------------------------------

  it(
    'gives one organisation only its share of a run',
    async () => {
      const ctx = await open();
      const tenantId = await createMailTenant(ctx.prisma);
      const rows = MAIL_WORKER_LANE_BATCH_MAX + 2;
      for (let row = 0; row < rows; row += 1) {
        await enqueueMail(ctx.prisma, { tenantId });
      }

      // The shared budget of fifty would let this one organisation take every row; the
      // per-lane share is what leaves the run to the others.
      expect((await ctx.worker.runOnce()).attempted).toBe(
        MAIL_WORKER_LANE_BATCH_MAX,
      );
      // Nothing is lost, only postponed — the rest goes out on the next run.
      expect((await ctx.worker.runOnce()).attempted).toBe(2);
    },
    CASE_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // A failure of ours is not the remote's, and never verbatim
  // -------------------------------------------------------------------------

  it(
    'does not blame the mail server for a body it could not build',
    async () => {
      const declared =
        'Zu dieser Nachricht ist kein Text gespeichert; sie wurde vor der ' +
        'Umstellung eingereiht und kann nicht erzeugt werden.';
      const ctx = await openWithRenderer(new Error(declared));
      const tenantId = await createMailTenant(ctx.prisma);
      await ownBlock(ctx, tenantId);
      const id = await enqueueMail(ctx.prisma, { tenantId });

      expect((await ctx.worker.runOnce()).deferred).toBe(1);

      const row = await ctx.prisma.mailLog.findUniqueOrThrow({ where: { id } });
      // The renderer's own sentence, which is written for this column …
      expect(row.lastError).toBe(declared);
      // … and **not** a category. An organisation with its own block used to read „Der
      // Mailserver hat die Nachricht nicht angenommen" — about a mail server
      // that was never asked, in the sentence its admin acts on.
      expect(row.lastError).not.toBe(MAIL_CATEGORY_REJECTED);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'keeps a defect’s message out of the column an editor reads',
    async () => {
      // A defect, not a declared refusal: its message was written for a
      // developer and here it carries the answer this mail is about. On the
      // inheriting path it used to be stored **verbatim** (a security review
      // finding).
      const ctx = await openWithRenderer(
        new TypeError(
          "Cannot read properties of undefined (reading 'x') — Anton Aktiv, Marktplatz 3",
        ),
      );
      const tenantId = await createMailTenant(ctx.prisma);
      const id = await enqueueMail(ctx.prisma, { tenantId });

      expect((await ctx.worker.runOnce()).deferred).toBe(1);

      const row = await ctx.prisma.mailLog.findUniqueOrThrow({ where: { id } });
      expect(row.lastError).toBe(MAIL_RENDER_FAILED_REASON);
      expect(row.lastError).not.toContain('Anton Aktiv');
      // Retried under the usual backoff, exactly as before: an unreadable
      // settings document is a temporary state and the queue is built for it.
      expect(row.attempts).toBe(1);
      expect(row.nextAttemptAt).not.toBeNull();
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'ends a lane after the first mail server that goes quiet',
    async () => {
      // Every send stalls past the send deadline: the mail server that accepts
      // the connection and then says nothing.
      const ctx = await open({ stallMs: 3_000 });
      const tenantId = await createMailTenant(ctx.prisma);
      for (let row = 0; row < 3; row += 1) {
        await enqueueMail(ctx.prisma, { tenantId });
      }

      const run = await ctx.worker.runOnce();
      // **One**, not three. The next row would buy the same silence at the same
      // price, and ten of them is the better part of an hour in which no new run
      // starts for anybody (`tick()` coalesces).
      expect(run).toMatchObject({ attempted: 1, deferred: 1 });
      expect(ctx.double?.attemptCount).toBe(1);

      const queued = await ctx.prisma.mailLog.count({
        where: { tenantId, attempts: 0 },
      });
      expect(queued).toBe(2);
    },
    CASE_TIMEOUT_MS,
  );
});
