import { randomBytes } from 'node:crypto';

import { MAIL_MAX_ATTEMPTS } from '@formsache/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MailBodyRenderer } from '../../src/mail/mail-body-renderer';
import { SYSTEM_IDENTITY_KEY } from '../../src/mail/mail-transport';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { TEST_SYSTEM_SMTP_BLOCK } from '../support/create-test-app';
import { IdentityRoutingDouble } from './identity-routing-double';
import {
  createMailContext,
  createMailTenant,
  enqueueMail,
  resetMailTables,
  type MailContext,
} from './mail-test-context';

/**
 * **The delivery log names the sender identity** (the requirement, a finding from an earlier test run).
 *
 * ## Why this file exists at all
 *
 * Up to here the log could say *that* a mail went out and not
 * *over what*. In an earlier test run „the one went over the own one, the other over the
 * system block" was proved at **two catch servers** — that is, outside the
 * application, at a place nobody in operation gets to. Exactly this
 * question arises when switching system→own, when SPF or DKIM starts
 * to refuse.
 *
 * ## The four pieces of evidence for the requirement, and what each carries on its own
 *
 * 1. **Two delivered rows name different identities.** What is measured
 *    is a *difference*, not a value: `senderIdentity` **and**
 *    `senderAddress` of both rows are set against each other. An
 *    assertion „row A says system" alone would stay green if the column stood
 *    hard on „System" — the reproduction that the requirement names.
 * 2. **A `failed` row names the identity under which it failed.**
 * 3. **A `queued` row names none.** In the sharper form: the worker
 *    *runs*, touches the row (it writes the „kein Mailserver" reason to it)
 *    and still writes no identity. A row that was merely never
 *    touched would be the weaker case.
 * 4. The tenant boundary — that one belongs to the read side and stands in
 *    `test/mail-log/mail-log-detail.spec.ts`, where `ScopedMailLogDelegate` is
 *    the only boundary of this table.
 *
 * On top of that three cases that are not pieces of evidence but **hold
 * decisions on record**: a row whose stored block could not be opened at all,
 * names no identity (there was none); a row whose **body** could not
 * be rendered, likewise none (no transport was asked); and a
 * row that waits again after a refused attempt names the one of the
 * attempt.
 */

const SETUP_TIMEOUT_MS = 180_000;

const SYSTEM_ADDRESS = TEST_SYSTEM_SMTP_BLOCK.from;
const OWN_ADDRESS = 'post@Organisation-beta.invalid';

/**
 * A renderer that does **not** hand over the body.
 *
 * The second way in which a delivery attempt fails, and the only one in which
 * no mail server was asked: `MailWorkerService.attemptDelivery` renders
 * first and chooses the transport afterwards. An `Error` with `name === 'Error'` is
 * no coincidence here, but the form that `renderFailureReason` lets through as „our
 * own malfunction" — a `TypeError` would be a defect and would get the
 * blanket sentence.
 */
class FailingBodyRenderer extends MailBodyRenderer {
  render(): Promise<never> {
    return Promise.reject(new Error('Der Rumpf ließ sich nicht rendern.'));
  }
}

describe('Versandprotokoll — Versandidentität', () => {
  let database: TestDatabase | undefined;
  let context: MailContext | undefined;

  beforeAll(async () => {
    database = await acquireTestDatabase();
  }, SETUP_TIMEOUT_MS);

  afterEach(async () => {
    // Closing empties the per-Organisation transport cache — without it, case *n+1*
    // would send over case *n*'s remote (see `mail-test-context.ts`).
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

  async function open(
    double: IdentityRoutingDouble,
    systemMail?: { readonly smtp: null },
    renderer?: MailBodyRenderer,
  ): Promise<MailContext> {
    context = await createMailContext({
      databaseUrl: url(),
      transport: double,
      ...(systemMail === undefined ? {} : { systemMail }),
      ...(renderer === undefined ? {} : { renderer }),
    });
    await resetMailTables(context.prisma);
    return context;
  }

  /** An organisation with its **own** block — the sealing the application itself does. */
  async function ownBlock(
    ctx: MailContext,
    tenantId: string,
    from = OWN_ADDRESS,
  ): Promise<void> {
    await ctx.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        smtp: ctx.secrets.sealTenantBlock(
          {
            host: 'smtp.Organisation-beta.invalid',
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

  async function row(
    ctx: MailContext,
    id: string,
  ): Promise<{
    status: string;
    senderIdentity: string | null;
    senderAddress: string | null;
    attempts: number;
  }> {
    const found = await ctx.prisma.mailLog.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        senderIdentity: true,
        senderAddress: true,
        attempts: true,
      },
    });
    return found;
  }

  // -------------------------------------------------------------------------
  // the evidence — two delivered rows, two different identities
  // -------------------------------------------------------------------------

  it('nennt für System-Block und eigenen Block verschiedene Identitäten', async () => {
    const double = new IdentityRoutingDouble();
    const ctx = await open(double);

    // Since ADR-0023 a row comes **over the system lane** to the block of the
    // installation, no longer through an organisation inheriting: the value
    // `trigger = 'system'` is the only condition under which it is still
    // chosen. The measurement — two rows, two identities — stays
    // the same.
    const systemSide = await createMailTenant(ctx.prisma, 'Organisation Alpha');
    const owning = await createMailTenant(ctx.prisma, 'Organisation Beta');
    await ownBlock(ctx, owning);

    const overSystem = await enqueueMail(ctx.prisma, {
      tenantId: systemSide,
      trigger: 'system',
    });
    const overOwn = await enqueueMail(ctx.prisma, { tenantId: owning });

    await ctx.worker.runOnce();

    const system = await row(ctx, overSystem);
    const own = await row(ctx, overOwn);

    expect(system.status).toBe('sent');
    expect(own.status).toBe('sent');

    // **The difference is the measurement**, not the single value: an
    // assertion on „system" alone would stay green if the column were set hard
    // on „System" — exactly the reproduction of the requirement.
    expect(system.senderIdentity).not.toBe(own.senderIdentity);
    expect(system.senderAddress).not.toBe(own.senderAddress);

    expect(system.senderIdentity).toBe('system');
    expect(system.senderAddress).toBe(SYSTEM_ADDRESS);
    expect(own.senderIdentity).toBe('own');
    expect(own.senderAddress).toBe(OWN_ADDRESS);

    // **Against the transport, not against the configuration.** The four
    // assertions above would also hold if the column were computed a second
    // time out of the same configuration, without the delivery ever having
    // followed it. `sendersFor` is the address that the double
    // actually had in its hand — with that this case measures „what went out
    // was recorded" instead of „what stood there was recorded".
    expect(double.sendersFor(SYSTEM_IDENTITY_KEY)).toStrictEqual([
      system.senderAddress,
    ]);
    expect(double.sendersFor(owning)).toStrictEqual([own.senderAddress]);
  });

  // -------------------------------------------------------------------------
  // the evidence — a failed row names the identity
  // -------------------------------------------------------------------------

  it('nennt an einer fehlgeschlagenen Zeile die Identität, unter der es scheiterte', async () => {
    const double = new IdentityRoutingDouble();
    const ctx = await open(double);

    const owning = await createMailTenant(ctx.prisma, 'Organisation Beta');
    await ownBlock(ctx, owning);
    // The own mail server refuses. There is no fallback — that is the rule —,
    // so the row ends under exactly this identity.
    double.refuse(owning);

    // One attempt before the last, so that this run becomes terminal: the
    // backoff staircase is not the subject here.
    const id = await enqueueMail(ctx.prisma, {
      tenantId: owning,
      attempts: MAIL_MAX_ATTEMPTS - 1,
    });

    await ctx.worker.runOnce();

    const failed = await row(ctx, id);
    expect(failed.status).toBe('failed');
    expect(failed.attempts).toBe(MAIL_MAX_ATTEMPTS);
    expect(failed.senderIdentity).toBe('own');
    expect(failed.senderAddress).toBe(OWN_ADDRESS);
  });

  it('nennt sie auch an einer wartenden Zeile, deren Versuch abgelehnt wurde', async () => {
    const double = new IdentityRoutingDouble();
    const ctx = await open(double);

    const owning = await createMailTenant(ctx.prisma, 'Organisation Beta');
    await ownBlock(ctx, owning);
    double.refuse(owning);

    const id = await enqueueMail(ctx.prisma, { tenantId: owning });
    await ctx.worker.runOnce();

    // `queued` **with** identity: the columns describe the attempt that
    // has taken place, not a promise about the next one. That is no
    // contradiction to the evidence below, but its delimitation — there no
    // attempt has taken place.
    const waiting = await row(ctx, id);
    expect(waiting.status).toBe('queued');
    expect(waiting.attempts).toBe(1);
    expect(waiting.senderIdentity).toBe('own');
  });

  // -------------------------------------------------------------------------
  // the evidence — an enqueued row names none
  // -------------------------------------------------------------------------

  it('nennt an einer eingereihten Zeile keine Identität — auch nicht nach einem Lauf', async () => {
    const double = new IdentityRoutingDouble();
    // The block of the installation is **set up** here (default of the
    // harness) and the organisation nevertheless has none: since ADR-0023 it is
    // therefore withheld instead of evading to the one of the installation. The
    // run touches the row — it writes the readable reason to it — and
    // still writes no identity.
    const ctx = await open(double);

    const withoutServer = await createMailTenant(
      ctx.prisma,
      'Organisation Alpha',
      null,
    );
    const id = await enqueueMail(ctx.prisma, { tenantId: withoutServer });

    const beforeRun = await row(ctx, id);
    expect(beforeRun.senderIdentity).toBe(null);
    expect(beforeRun.senderAddress).toBe(null);

    await ctx.worker.runOnce();

    const withheld = await row(ctx, id);
    expect(withheld.status).toBe('queued');
    // No attempt, no counter — and no identity. If the column were written at
    // the **enqueue**, „system" would stand here although nothing was ever
    // sent: that is the reproduction that makes this case red.
    expect(withheld.attempts).toBe(0);
    expect(withheld.senderIdentity).toBe(null);
    expect(withheld.senderAddress).toBe(null);
    // And the functioning block of the installation was not used —
    // without this line the case would stay green even if the inheritance
    // came back and the row went out over the installation.
    expect(double.sendersFor(SYSTEM_IDENTITY_KEY)).toStrictEqual([]);
  });

  // -------------------------------------------------------------------------
  // The decision: an unreadable block has no identity
  // -------------------------------------------------------------------------

  it('nennt keine Identität, wenn der gespeicherte Block gar nicht zu öffnen war', async () => {
    const double = new IdentityRoutingDouble();
    const ctx = await open(double);

    const broken = await createMailTenant(ctx.prisma, 'Organisation Gamma');
    await ctx.prisma.tenant.update({
      where: { id: broken },
      // Half filled: the application cannot produce this state and
      // refuses to interpret it (ADR-0013 no. 4).
      data: { smtp: { host: 'smtp.gamma.invalid' } },
    });

    const id = await enqueueMail(ctx.prisma, { tenantId: broken });
    await ctx.worker.runOnce();

    const failed = await row(ctx, id);
    expect(failed.status).toBe('failed');
    // No transport was asked, so there is no identity under which
    // it failed. Entering „system" here would be the invention that
    // ADR-0013 no. 2 warns about — and of all things at an organisation with an own block.
    expect(failed.senderIdentity).toBe(null);
    expect(failed.senderAddress).toBe(null);
  });

  // -------------------------------------------------------------------------
  // The decision: a render error has none either — it asks no
  // transport (a review finding of the review gate for this requirement)
  // -------------------------------------------------------------------------

  it('nennt keine Identität, wenn der Rumpf sich nicht rendern ließ — in beiden Ausgängen', async () => {
    const double = new IdentityRoutingDouble();
    // The organisation has an **own**, impeccable block: the identity is therefore
    // resolved, and exactly for that reason it stood in the row before. The attempt
    // fails nevertheless before any mail server learns of it — and
    // „Eigener Mailserver dieser Organisation (post@…)" would then send the SPF/DKIM search
    // to a host that has never seen the message.
    const ctx = await open(double, undefined, new FailingBodyRenderer());

    const owning = await createMailTenant(ctx.prisma, 'Organisation Beta');
    await ownBlock(ctx, owning);

    // Both outcomes of the same error in one run: the row at the
    // attempt limit ends terminally (`markFailed`), the fresh one keeps waiting
    // with backoff (`markRetry`). The difference counts because they are two
    // write places — forgetting one of them would otherwise stay green.
    const terminal = await enqueueMail(ctx.prisma, {
      tenantId: owning,
      attempts: MAIL_MAX_ATTEMPTS - 1,
    });
    const deferred = await enqueueMail(ctx.prisma, { tenantId: owning });

    await ctx.worker.runOnce();

    const failed = await row(ctx, terminal);
    expect(failed.status).toBe('failed');
    expect(failed.attempts).toBe(MAIL_MAX_ATTEMPTS);
    expect(failed.senderIdentity).toBe(null);
    expect(failed.senderAddress).toBe(null);

    const waiting = await row(ctx, deferred);
    expect(waiting.status).toBe('queued');
    expect(waiting.attempts).toBe(1);
    expect(waiting.senderIdentity).toBe(null);
    expect(waiting.senderAddress).toBe(null);

    // The reasoning, measured instead of asserted: the transport of this organisation
    // was not asked a single time. Without this assertion the case would stay
    // green even if it recorded nothing for a completely different reason.
    expect(double.attemptsFor(owning)).toStrictEqual([]);
  });
});
