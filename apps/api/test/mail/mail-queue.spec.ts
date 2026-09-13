import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { MAIL_MAX_ATTEMPTS } from '@formsache/shared';

import { MAIL_BACKOFF_MAX_MS } from '../../src/mail/mail-backoff';
import { MAIL_CATEGORY_REJECTED } from '../../src/mail/mail-error-category';
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
 * The mail queue against a real PostgreSQL database (ADR-0004).
 *
 * Everything here is about **numbers**, not about statuses: „endet auf `sent`"
 * is satisfied by a queue with no retry at all, „liegt in der Zukunft" by a
 * constant, and „hört irgendwann auf" by a test that stops asking. Each case
 * below therefore names the count it measures and why the obvious weaker
 * assertion would have proven nothing.
 *
 * No test in this file sleeps: the clock is injected and moved by hand.
 */

const SETUP_TIMEOUT_MS = 180_000;

/** Comfortably past any backoff the worker can compute. */
const PAST_ANY_BACKOFF_MS = MAIL_BACKOFF_MAX_MS + 60_000;

describe('mail queue worker', () => {
  let database: TestDatabase | undefined;
  let context: MailContext | undefined;

  beforeAll(async () => {
    database = await acquireTestDatabase();
  }, SETUP_TIMEOUT_MS);

  afterEach(async () => {
    await context?.close();
    context = undefined;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await database?.release();
  });

  /** One context per case, because each one scripts its transport differently. */
  async function open(transport?: SmtpDouble): Promise<MailContext> {
    if (database === undefined) {
      throw new Error('no test database');
    }
    context = await createMailContext({
      databaseUrl: database.url,
      ...(transport === undefined ? {} : { transport }),
    });
    // The counts below are counts over the whole table; a row left behind by
    // the previous case would answer for it.
    await resetMailTables(context.prisma);
    return context;
  }

  it('fails twice, succeeds on the third attempt — and records three attempts', async () => {
    const transport = new SmtpDouble({ script: ['fail', 'fail', 'ok'] });
    const { prisma, worker, clock } = await open(transport);
    const tenantId = await createMailTenant(prisma);
    const id = await enqueueMail(prisma, { tenantId });

    for (let round = 0; round < 3; round += 1) {
      await worker.runOnce();
      clock.advance(PAST_ANY_BACKOFF_MS);
    }

    const row = await prisma.mailLog.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('sent');
    // **The number, not the status.** A queue that swallowed the first two
    // failures and delivered once would also end on `sent`; only `attempts`
    // says the two refusals were seen and retried.
    expect(row.attempts).toBe(3);
    expect(transport.attemptCount).toBe(3);
    expect(row.sentAt).not.toBeNull();
    expect(row.nextAttemptAt).toBeNull();
    expect(row.lastError).toBeNull();
  });

  it('spaces retries further and further apart', async () => {
    const transport = new SmtpDouble({ then: 'fail' });
    const { prisma, worker, clock } = await open(transport);
    const tenantId = await createMailTenant(prisma);
    const id = await enqueueMail(prisma, { tenantId });

    const firstStart = clock.now();
    await worker.runOnce();
    const afterFirst = await prisma.mailLog.findUniqueOrThrow({
      where: { id },
    });
    const firstGap =
      (afterFirst.nextAttemptAt?.getTime() ?? 0) - firstStart.getTime();

    // Move to exactly the moment the queue itself named as the next try.
    const secondStart = afterFirst.nextAttemptAt ?? firstStart;
    clock.set(secondStart);
    await worker.runOnce();
    const afterSecond = await prisma.mailLog.findUniqueOrThrow({
      where: { id },
    });
    const secondGap =
      (afterSecond.nextAttemptAt?.getTime() ?? 0) - secondStart.getTime();

    expect(firstGap).toBeGreaterThan(0);
    // The comparison is the assertion. „nextAttemptAt liegt in der Zukunft"
    // would be green against a fixed fifteen-second retry, which is precisely
    // the behaviour the requirement rules out („statt den Mailserver im
    // Sekundentakt zu befragen").
    expect(secondGap).toBeGreaterThan(firstGap);
    expect(afterSecond.attempts).toBe(2);
    expect(afterSecond.status).toBe('queued');
  });

  it('does not touch a row again before its backoff has elapsed', async () => {
    const transport = new SmtpDouble({ then: 'fail' });
    const { prisma, worker } = await open(transport);
    const tenantId = await createMailTenant(prisma);
    await enqueueMail(prisma, { tenantId });

    await worker.runOnce();
    expect(transport.attemptCount).toBe(1);

    // Same instant on the clock — nothing is due.
    const second = await worker.runOnce();

    // This is the case that proves the backoff is *used*. Without
    // `next_attempt_at` in the claim's predicate the computed delay would be
    // stored and ignored, and every other assertion in this file would stay
    // green.
    expect(second.attempted).toBe(0);
    expect(transport.attemptCount).toBe(1);
  });

  it('gives up after the attempt ceiling and stops asking', async () => {
    const transport = new SmtpDouble({
      then: 'fail',
      failureMessage: 'Mailserver hat die Annahme verweigert',
    });
    const { prisma, worker, clock } = await open(transport);
    const tenantId = await createMailTenant(prisma);
    const id = await enqueueMail(prisma, { tenantId });

    for (let round = 0; round < MAIL_MAX_ATTEMPTS; round += 1) {
      await worker.runOnce();
      clock.advance(PAST_ANY_BACKOFF_MS);
    }

    const exhausted = await prisma.mailLog.findUniqueOrThrow({ where: { id } });
    expect(exhausted.status).toBe('failed');
    expect(exhausted.attempts).toBe(MAIL_MAX_ATTEMPTS);
    /*
     * **A category, not the wording of the other side** — and since ADR-0023
     * this is the normal case instead of the exception.
     *
     * Previously this organisation inherited the installation's block, and for
     * that one the verbatim style applies (`queueReasonStyle`): its operator is
     * the superadmin who chose the host. Without inheritance it sends through
     * its **own** block, and the reader of this line is the organisation
     * — that is, the category that ADR-0013 „Consequences" demands for exactly
     * this case: it says what is to be done without saying which ports are
     * open.
     */
    expect(exhausted.lastError).toBe(MAIL_CATEGORY_REJECTED);
    expect(exhausted.lastError).not.toContain(
      'Mailserver hat die Annahme verweigert',
    );
    expect(exhausted.nextAttemptAt).toBeNull();

    // **One run more than the ceiling.** A test that stopped at
    // MAIL_MAX_ATTEMPTS would be green against a worker with no ceiling at
    // all — it would simply never have asked for the attempt that must not
    // happen.
    const attemptsBefore = transport.attemptCount;
    clock.advance(PAST_ANY_BACKOFF_MS);
    const extra = await worker.runOnce();

    expect(extra.attempted).toBe(0);
    expect(transport.attemptCount).toBe(attemptsBefore);
    const afterwards = await prisma.mailLog.findUniqueOrThrow({
      where: { id },
    });
    expect(afterwards.attempts).toBe(MAIL_MAX_ATTEMPTS);
  });

  it('may deliver twice after a crash, but never writes a second log line', async () => {
    const transport = new SmtpDouble();
    const { prisma, worker, repository, clock } = await open(transport);
    const tenantId = await createMailTenant(prisma);
    const id = await enqueueMail(prisma, { tenantId });

    // The at-least-once seam of ADR-0004, staged where it really sits: the
    // transport has already accepted the mail and the status write is what
    // fails. Everything before this line has happened for real.
    vi.spyOn(repository, 'markSent').mockRejectedValueOnce(
      new Error('connection reset while recording the send'),
    );

    // **Counted, not thrown** (a review finding). The run used to reject
    // here, which discarded the totals of every *other* lane that had already
    // committed its sends — seven lanes, forty mails, „failed, 0 sent". The
    // crash is this organisation's, so it costs this organisation's lane and is reported.
    const crashed = await worker.runOnce();
    expect(crashed).toMatchObject({ attempted: 0, sent: 0, laneFailures: 1 });

    const midway = await prisma.mailLog.findUniqueOrThrow({ where: { id } });
    expect(midway.status).toBe('queued');
    expect(transport.attemptCount).toBe(1);

    clock.advance(PAST_ANY_BACKOFF_MS);
    await worker.runOnce();

    const finished = await prisma.mailLog.findUniqueOrThrow({ where: { id } });
    expect(finished.status).toBe('sent');
    // Delivered twice — that is the documented cost of at-least-once …
    expect(transport.attemptCount).toBe(2);
    // … and this is the promise that goes with it: one recipient, one line.
    expect(await prisma.mailLog.count()).toBe(1);
  });
});
