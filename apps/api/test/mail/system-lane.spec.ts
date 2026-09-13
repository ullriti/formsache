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
  MAIL_NOT_CONFIGURED_REASON,
  SYSTEM_IDENTITY_KEY,
} from '../../src/mail/mail-transport';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  TEST_SYSTEM_SMTP_BLOCK,
  writeSystemMail,
} from '../support/create-test-app';
import { SmtpDouble } from '../support/smtp-double';
import {
  createMailContext,
  createMailTenant,
  enqueueMail,
  resetMailTables,
  type MailContext,
} from './mail-test-context';

/**
 * **The system lane — one lane, one identity** (ADR-0020, a
 * production bug from the review).
 *
 * ## The constellation that shut down an organisation's queue
 *
 * Organisation T has its **own** SMTP block; the installation has
 * **none**. In T's queue lies a `trigger = 'system'` row — a
 * reset mail or the notification about a password that has been set — and it is
 * the oldest.
 *
 * As long as one lane carried two identities, it ran like this: the claim took the
 * system row first (`ORDER BY created_at`), the system identity answered
 * `withhold` (the installation has no block), the row stayed `queued` with
 * `next_attempt_at = NULL` — and the caller stamped „Kein Mailserver
 * konfiguriert" onto **every** other waiting row of this organisation and
 * aborted the lane. On the next run the same row was the oldest again
 * and due again.
 *
 * The consequence was not a delay but a permanent state: this
 * organisation's registration confirmations **never** went out, although its
 * own mail server worked flawlessly, and in the delivery log each of
 * them carried a reason that was demonstrably wrong.
 *
 * ## Why it would not have turned red without this file
 *
 * `identity-fail-closed.spec.ts` checks "organisation inherits **and** system has
 * no block" — there both identities have the same answer, and the bug
 * disappears. `password-reset-delivery.spec.ts` always sets up a
 * system block. Only the crossing of the two — own block **without**
 * system block — separates the two identities within one queue.
 */

const SETUP_TIMEOUT_MS = 180_000;
const CASE_TIMEOUT_MS = 60_000;

/** The organisation's host — it works, and that is half the statement. */
const OWN_HOST = 'mail.eigen.invalid';

describe('die Systembahn hält nur ihre eigenen Zeilen zurück', () => {
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

  /**
   * A setup **without** system block, with a working double.
   *
   * `systemMail: { smtp: null }` is the explicit renunciation: the double
   * stays, but the installation has entered nothing. Exactly this crossing
   * — a working transport and no system configuration — makes the
   * difference between "nothing went out because nothing could go" and
   * "nothing went out although everything stood ready" measurable.
   */
  async function openWithoutSystemBlock(): Promise<MailContext> {
    const ctx = await createMailContext({
      databaseUrl: url(),
      transport: new SmtpDouble(),
      systemMail: { smtp: null },
    });
    context = ctx;
    await resetMailTables(ctx.prisma);
    return ctx;
  }

  /** An organisation that sends over its **own** mail server. */
  async function withOwnBlock(ctx: MailContext, name: string): Promise<string> {
    const tenantId = await createMailTenant(ctx.prisma, name);
    await ctx.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        smtp: ctx.secrets.sealTenantBlock(
          {
            host: OWN_HOST,
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
    return tenantId;
  }

  // -------------------------------------------------------------------------
  // The finding itself
  // -------------------------------------------------------------------------

  it(
    'stellt die Post einer Organisation zu, während ihre Systemzeile wartet',
    async () => {
      const ctx = await openWithoutSystemBlock();
      const tenantId = await withOwnBlock(ctx, 'Organisation mit Mailserver');

      // **The system row is the older one** — that is the trigger, not a
      // coincidence of the ordering: `claim` takes `ORDER BY created_at ASC`, so
      // it was the one that aborted the lane before the confirmation got its
      // turn. One minute is enough and is independent of the clock's resolution.
      const older = new Date(ctx.clock.now().getTime() - 60_000);
      const systemRow = await enqueueMail(ctx.prisma, {
        tenantId,
        trigger: 'system',
        subject: 'Passwort zurücksetzen',
        createdAt: older,
      });
      const confirmation = await enqueueMail(ctx.prisma, {
        tenantId,
        subject: 'Anmeldung eingegangen',
      });

      const run = await ctx.worker.runOnce();

      // **The confirmation goes out** — over the organisation's own mail
      // server, in the same run in which the system row is withheld.
      // Before: 0 sent, and that again on every further run.
      expect(run).toMatchObject({ attempted: 1, sent: 1, laneFailures: 0 });
      expect(ctx.double?.identities).toHaveLength(1);
      expect(ctx.double?.identities[0]?.key).toBe(tenantId);
      expect(ctx.double?.identities[0]?.block.host).toBe(OWN_HOST);

      const delivered = await ctx.prisma.mailLog.findUniqueOrThrow({
        where: { id: confirmation },
      });
      expect(delivered.status).toBe('sent');
      // **And no wrong reason on it.** That was the second half of the
      // bug: „Kein Mailserver konfiguriert" stood in the delivery log on
      // rows whose mail server demonstrably worked.
      expect(delivered.lastError).toBeNull();

      // The system row waits — not `failed`, no attempt used up
      // (ADR-0013 no. 5, first line), and with the reason that is correct for
      // **it**.
      const held = await ctx.prisma.mailLog.findUniqueOrThrow({
        where: { id: systemRow },
      });
      expect(held.status).toBe('queued');
      expect(held.attempts).toBe(0);
      expect(held.lastError).toBe(MAIL_NOT_CONFIGURED_REASON);
      expect(run.withheld).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'löst die wartende Systemzeile auf, sobald die Installation einen Block hat',
    async () => {
      const ctx = await openWithoutSystemBlock();
      const tenantId = await withOwnBlock(ctx, 'Organisation mit Mailserver');
      const systemRow = await enqueueMail(ctx.prisma, {
        tenantId,
        trigger: 'system',
        createdAt: new Date(ctx.clock.now().getTime() - 60_000),
      });
      await enqueueMail(ctx.prisma, { tenantId });

      expect((await ctx.worker.runOnce()).sent).toBe(1);
      // A second run without a change writes nothing new: the row already
      // carries the reason, and `withheld` stays readable.
      expect((await ctx.worker.runOnce()).withheld).toBe(0);

      // The superadmin enters a mail server — no restart, no cache
      // (ADR-0011): the next run uses it.
      await writeSystemMail(ctx.prisma, ctx.secrets, {
        smtp: TEST_SYSTEM_SMTP_BLOCK,
      });

      const released = await ctx.worker.runOnce();
      expect(released).toMatchObject({ attempted: 1, sent: 1, withheld: 0 });

      const sent = await ctx.prisma.mailLog.findUniqueOrThrow({
        where: { id: systemRow },
      });
      expect(sent.status).toBe('sent');
      // **Over the installation, never over the organisation** — the
      // security boundary of ADR-0020, here at the row that got stuck
      // before.
      expect(ctx.double?.identities.at(-1)?.key).toBe(SYSTEM_IDENTITY_KEY);
      expect(ctx.double?.identities.at(-1)?.block.host).toBe(
        TEST_SYSTEM_SMTP_BLOCK.host,
      );
      expect(sent.senderIdentity).toBe('system');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'stempelt den Grund einer Systemzeile nicht auf eine andere Organisation',
    async () => {
      const ctx = await openWithoutSystemBlock();
      const holder = await withOwnBlock(ctx, 'Organisation mit Systemzeile');
      const other = await withOwnBlock(ctx, 'Organisation nebenan');

      await enqueueMail(ctx.prisma, {
        tenantId: holder,
        trigger: 'system',
        createdAt: new Date(ctx.clock.now().getTime() - 60_000),
      });
      const nextDoor = await enqueueMail(ctx.prisma, { tenantId: other });

      const run = await ctx.worker.runOnce();

      // The system lane reaches across all organisations, its reason must
      // not: `withholdOthers` is restricted to the lane, not to the
      // table. Without the restriction the neighbour's row would carry the same
      // reason — and would nevertheless have been sent, which makes the
      // contradiction visible.
      expect(run.sent).toBe(1);
      const untouched = await ctx.prisma.mailLog.findUniqueOrThrow({
        where: { id: nextDoor },
      });
      expect(untouched.status).toBe('sent');
      expect(untouched.lastError).toBeNull();
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * **The reason of a lane goes only to rows that this lane would also look
   * at** (a review finding).
   *
   * `withholdOthers` carried neither {@link NOT_IN_TRASH} nor `NOT_ERASED` — the
   * two of the six conditions that `claim`, `dueTenants` and `systemMailDue`
   * all three carry. As long as there were only lanes per organisation, that was
   * without consequence: a row in the trash got a reason stamped on it that it
   * never needed, and no more. The system lane stamps across **all**
   * organisations, hence also into deleted ones — an organisation in the
   * trash would get today's error message written onto its old mail,
   * although nothing is being attempted on it right now.
   *
   * Nothing becomes deliverable through that: `last_error` is display, and the
   * claim statements do not see the row anyway. What is wrong is the **statement**
   * — and a delivery log that shows reasons for attempts that did not
   * happen is exactly the finding from which `withholdOthers` has its lane cut.
   */
  it(
    'stempelt keine Zeile einer gelöschten Organisation',
    async () => {
      const ctx = await openWithoutSystemBlock();
      const holder = await withOwnBlock(ctx, 'Organisation mit Systemzeile');
      const deleted = await withOwnBlock(ctx, 'Gelöschte Organisation');

      // The claimable row that produces the reason: it is the older one, so
      // the system lane takes it first.
      await enqueueMail(ctx.prisma, {
        tenantId: holder,
        trigger: 'system',
        createdAt: new Date(ctx.clock.now().getTime() - 60_000),
      });
      // …and two that the run would **not** look at: one in a
      // deleted organisation, one with finally emptied columns.
      const inTrash = await enqueueMail(ctx.prisma, {
        tenantId: deleted,
        trigger: 'system',
      });
      const erased = await enqueueMail(ctx.prisma, {
        tenantId: holder,
        trigger: 'system',
      });
      await ctx.prisma.tenant.update({
        where: { id: deleted },
        data: { deletedAt: new Date() },
      });
      await ctx.prisma.mailLog.update({
        where: { id: erased },
        data: { recipient: null, subject: null },
      });

      const run = await ctx.worker.runOnce();

      // The lane's own row carries the reason — that is the counter-check,
      // without which even a server that no longer stamps at all would be green.
      expect(run.withheld).toBe(1);

      for (const id of [inTrash, erased]) {
        const untouched = await ctx.prisma.mailLog.findUniqueOrThrow({
          where: { id },
        });
        expect(untouched.status).toBe('queued');
        expect(untouched.lastError).toBeNull();
      }
    },
    CASE_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // One lane for all system rows, not one per organisation
  // -------------------------------------------------------------------------

  it(
    'schickt die Systemzeilen mehrerer Organisationen über eine Identität',
    async () => {
      const ctx = await createMailContext({
        databaseUrl: url(),
        transport: new SmtpDouble(),
      });
      context = ctx;
      await resetMailTables(ctx.prisma);

      const first = await withOwnBlock(ctx, 'Organisation Alpha');
      const second = await withOwnBlock(ctx, 'Organisation Beta');
      for (const tenantId of [first, second]) {
        await enqueueMail(ctx.prisma, { tenantId, trigger: 'system' });
      }

      const run = await ctx.worker.runOnce();

      expect(run).toMatchObject({ attempted: 2, sent: 2, laneFailures: 0 });
      // Both over **one** key, thus over one cached connection —
      // the consideration out of which `SYSTEM_IDENTITY_KEY` exists at all. A
      // system lane per organisation would be one connection per organisation to
      // the same mail server.
      expect(ctx.double?.identities.map((identity) => identity.key)).toEqual([
        SYSTEM_IDENTITY_KEY,
        SYSTEM_IDENTITY_KEY,
      ]);
      // And not over the own block of either of the two, although both have
      // one.
      for (const identity of ctx.double?.identities ?? []) {
        expect(identity.block.host).not.toBe(OWN_HOST);
      }
    },
    CASE_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // The guard behind the lane condition
  // -------------------------------------------------------------------------

  it(
    'weigert sich zu senden, wenn eine Zeile in der falschen Bahn ankommt',
    async () => {
      const ctx = await createMailContext({
        databaseUrl: url(),
        transport: new SmtpDouble(),
      });
      context = ctx;
      await resetMailTables(ctx.prisma);

      const tenantId = await withOwnBlock(ctx, 'Organisation mit Mailserver');
      // An ordinary row, thus exactly one lane: that of the organisation.
      // No system row in play, so that the case has nothing to do with the
      // ordering of two lanes.
      const row = await enqueueMail(ctx.prisma, { tenantId });

      // **The bug the guard stands against is not ill will but
      // a `WHERE` that somebody changes.** `$queryRaw` types its result
      // itself, so the lane condition is a promise and not a proof. Without
      // the guard a reset mail would go out over the organisation's
      // mail server — the privilege escalation of ADR-0020 — and **nothing
      // would be red**, because the mail goes out.
      const claim = ctx.repository.claim.bind(ctx.repository);
      vi.spyOn(ctx.repository, 'claim').mockImplementation(
        async (tx, now, id) => {
          const claimed = await claim(tx, now, id);
          return claimed === null
            ? null
            : { ...claimed, trigger: 'system' as const };
        },
      );

      // Loud, and loud all the way to the outside: this is one of the two
      // exceptions that end the whole run instead of costing one lane
      // (`endsTheRun`).
      await expect(ctx.worker.runOnce()).rejects.toThrow(
        /does not belong to the lane/,
      );

      // The counter that carries the case: a mail sent under the wrong
      // identity does not fail.
      expect(ctx.double?.identities).toHaveLength(0);
      const untouched = await ctx.prisma.mailLog.findUniqueOrThrow({
        where: { id: row },
      });
      expect(untouched.status).toBe('queued');
      expect(untouched.attempts).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );
});
