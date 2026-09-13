import { randomBytes } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { fingerprint } from '../../src/mail/mail-transport';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { startSmtpInbox, type SmtpInbox } from '../support/smtp-inbox';
import {
  createMailContext,
  createMailTenant,
  enqueueMail,
  resetMailTables,
  StubBodyRenderer,
  type MailContext,
} from './mail-test-context';

/**
 * **The transporter cache, and the moment it has to be thrown away**
 * (ADR-0013 no. 7).
 *
 * ## Why two real mail servers and not a double
 *
 * The cache lives in `NodemailerTransport`. A double has none — it would report
 * the new block cheerfully while the real transport went on talking to the old
 * server, which is precisely the failure being tested. So the two remotes are
 * two `smtp-server` listeners on loopback, and the assertion is **which of them
 * received the message**. That is the only instrument that can tell „the
 * configuration changed" from „the connection changed".
 *
 * ADR-0013 no. 7 calls the missing half „die stillste Falle hier": an
 * organisation switches its mail server, the surface shows the new one, and mail goes
 * over the old one until the next restart. Nobody notices, because **both
 * work** — which is exactly the situation below, and why the case would be
 * green without the second inbox.
 *
 * ## The reproduction
 *
 * Taking the fingerprint comparison out of `transporterFor` (returning any held
 * transporter for the key) leaves the second message in the **first** inbox and
 * turns this case red. Nothing else in the suite notices.
 *
 * Both listeners bind to `127.0.0.1` and every address is `…@example.invalid`;
 * no run can reach a real mailbox.
 */

const SETUP_TIMEOUT_MS = 180_000;
const CASE_TIMEOUT_MS = 60_000;

describe('the transport cache per organisation ', () => {
  let database: TestDatabase | undefined;
  let context: MailContext | undefined;
  let first: SmtpInbox | undefined;
  let second: SmtpInbox | undefined;

  beforeAll(async () => {
    database = await acquireTestDatabase();
  }, SETUP_TIMEOUT_MS);

  afterEach(async () => {
    await context?.close();
    context = undefined;
    await first?.close();
    first = undefined;
    await second?.close();
    second = undefined;
  });

  afterAll(async () => {
    await database?.release();
  });

  /** The organisation's own block, pointed at one of the two listeners. */
  async function pointAt(
    ctx: MailContext,
    tenantId: string,
    port: number,
    password: string,
  ): Promise<void> {
    await ctx.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        smtp: ctx.secrets.sealTenantBlock(
          {
            host: '127.0.0.1',
            port,
            secure: false,
            from: 'post@organisation.invalid',
            auth: {
              user: 'Organisation',
              password: { kind: 'typed', value: password },
            },
          },
          tenantId,
        ),
      },
    });
  }

  it(
    'sends over the new mail server as soon as the block changes',
    async () => {
      if (database === undefined) {
        throw new Error('no test database');
      }
      const alt = await startSmtpInbox();
      first = alt;
      const neu = await startSmtpInbox();
      second = neu;

      const ctx = await createMailContext({
        databaseUrl: database.url,
        // The real transport — the cache under test is its own.
        useRealTransport: true,
        renderer: new StubBodyRenderer({ text: 'Anmeldung eingegangen.' }),
      });
      context = ctx;
      await resetMailTables(ctx.prisma);

      const password = `pw-${randomBytes(9).toString('hex')}`;
      const tenantId = await createMailTenant(
        ctx.prisma,
        'Organisation Wechsel',
      );
      await pointAt(ctx, tenantId, alt.port, password);

      await enqueueMail(ctx.prisma, {
        tenantId,
        recipient: 'erste@example.invalid',
      });
      expect((await ctx.worker.runOnce()).sent).toBe(1);

      // The control: the connection really was built and really was used.
      expect(alt.messages).toHaveLength(1);
      expect(alt.messages[0]?.to).toEqual(['erste@example.invalid']);
      expect(neu.messages).toHaveLength(0);

      // The organisation moves house. Same key in the cache, different block.
      await pointAt(ctx, tenantId, neu.port, password);

      await enqueueMail(ctx.prisma, {
        tenantId,
        recipient: 'zweite@example.invalid',
      });
      expect((await ctx.worker.runOnce()).sent).toBe(1);

      // **The measurement.** Held cache: the second mail lands at `alt` and
      // this is the only assertion in the repository that would notice.
      expect(neu.messages).toHaveLength(1);
      expect(neu.messages[0]?.to).toEqual(['zweite@example.invalid']);
      expect(alt.messages).toHaveLength(1);
    },
    CASE_TIMEOUT_MS,
  );
});

/**
 * The mark the cache compares — **every field of the block, without exception**.
 *
 * A unit case rather than a comment, because the previous version left `from`
 * out and its doc claimed „every field, the password included". The list is the
 * thing that rots: whoever adds a field to the indivisible block of the requirement
 * has to see this fail rather than discover, months later, that two organisations with
 * the same server and different sender addresses share one transporter.
 */
describe('the block fingerprint', () => {
  const block = {
    host: 'mail.organisation.invalid',
    port: 587,
    secure: false,
    from: 'post@organisation.invalid',
    auth: { user: 'Organisation', password: 'geheim' },
  } as const;

  it.each([
    ['host', { ...block, host: 'mail.andere.invalid' }],
    ['port', { ...block, port: 465 }],
    ['secure', { ...block, secure: true }],
    ['from', { ...block, from: 'vorstand@organisation.invalid' }],
    ['user', { ...block, auth: { ...block.auth, user: 'anderer' } }],
    ['password', { ...block, auth: { ...block.auth, password: 'neu' } }],
    ['auth at all', { ...block, auth: null }],
  ])('changes when %s changes', (_field, changed) => {
    expect(fingerprint(changed)).not.toBe(fingerprint(block));
  });

  it('is stable for the same block', () => {
    expect(fingerprint({ ...block, auth: { ...block.auth } })).toBe(
      fingerprint(block),
    );
  });
});
