import { ConsoleLogger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { TENANT_MAIL_NOT_CONFIGURED_REASON } from '../../src/mail/mail-transport';
import {
  MAIL_NOT_CONFIGURED_STARTUP_WARNING,
  MailWorkerService,
} from '../../src/mail/mail-worker.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { createTestApp, type TestApp } from '../support/create-test-app';
import { createTenant } from '../support/fixtures';
import {
  createMailContext,
  createMailTenant,
  enqueueMail,
  resetMailTables,
  type MailContext,
} from './mail-test-context';
import { captureStdio } from './stdio-capture';

/**
 * An organisation without a mail server — and an installation without one of
 * its own.
 *
 * Since ADR-0023 these are **two** states and no longer one: the row of an
 * organisation stays put because *this organisation* has no mail server, and
 * the startup notice speaks of the mail server *of the installation*. Both are
 * still `queued` and never `failed`, and that is exactly what this file pins
 * down.
 *
 * **The SMTP variables are absent, not empty.** `create-test-app.ts` ships no
 * `SMTP_*` at all and this file adds none. Setting them to `''` would be a
 * different test: the environment schema maps a blank value to „absent", so it
 * would additionally depend on that mapping — and would leave the case where
 * the variable is genuinely missing untested.
 *
 * The two halves are checked through two different boots, and the reason is
 * worth stating because it looks like an inconsistency otherwise:
 *
 * - „**startet die Anwendung normal** und die Mail bleibt liegen" is about the
 *   *application*, so it runs against the whole `AppModule` (`createTestApp`).
 * - „**sagt es beim Start einmal deutlich im Log**" cannot be observed there.
 *   `@nestjs/testing` installs a `TestingLogger` in `compile()` whose `log`,
 *   `warn`, `debug` and `verbose` are empty methods — only `error` reaches the
 *   console. The notice is a *warning* on purpose (an installation without a
 *   mail server is a supported state, not a fault), so it is invisible to any
 *   suite booted through `Test.createTestingModule`, `createTestApp` included.
 *   The counting case therefore boots the mail module with a real
 *   `ConsoleLogger` — the same logger `NestFactory.create` leaves in place in
 *   the shipped application — and drives the same `onModuleInit`.
 */

const SETUP_TIMEOUT_MS = 180_000;

/**
 * How many worker runs the count spans.
 *
 * More than one, because that is the whole point: „einmal" said once per run
 * would be indistinguishable from „einmal" said once per process if the test
 * only ran the worker a single time.
 */
const WORKER_RUNS = 4;

describe('mail without SMTP configuration', () => {
  let database: TestDatabase | undefined;
  let context: MailContext | undefined;

  beforeAll(async () => {
    database = await acquireTestDatabase();
  }, SETUP_TIMEOUT_MS);

  afterEach(async () => {
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

  it('starts, accepts the mail and leaves it queued with a readable reason', async () => {
    let testApp: TestApp | undefined;
    try {
      // The application boots without a single SMTP variable — the first half
      // of this requirement, and the reason `createTestApp` is used here at all.
      testApp = await createTestApp({ databaseUrl: url() });
      const prisma = testApp.prisma;
      // **Explicitly without a mail server of its own** (ADR-0023): that is
      // the state this file measures, and it is stated instead of inherited.
      const tenant = await createTenant(prisma, 'ALPHA', null);
      const row = await prisma.mailLog.create({
        data: {
          tenantId: tenant.id,
          recipient: 'bbr@example.invalid',
          subject: 'Anmeldung eingegangen',
          status: 'queued',
        },
      });

      const worker = testApp.app.get(MailWorkerService);
      for (let round = 0; round < WORKER_RUNS; round += 1) {
        await worker.runOnce();
      }

      const after = await prisma.mailLog.findUniqueOrThrow({
        where: { id: row.id },
      });
      // `queued`, not `failed`: nothing was refused and nothing was attempted,
      // so a worker configured next month still has to send this.
      expect(after.status).toBe('queued');
      // The exact text, because the sharpest trap is „den Grund weglassen" — an assertion
      // on „lastError is not null" would survive an empty string.
      expect(after.lastError).toBe(TENANT_MAIL_NOT_CONFIGURED_REASON);
      expect(after.sentAt).toBeNull();
      // Untouched: nothing was attempted, so nothing may be counted —
      // otherwise five quiet worker runs would burn the row's whole allowance
      // before an administrator ever entered an SMTP host.
      expect(after.attempts).toBe(0);
      expect(after.nextAttemptAt).toBeNull();
    } finally {
      await testApp?.close();
    }
  });

  it('says it exactly once, over startup and four worker runs', async () => {
    // Armed before the module boots: the promise is about the startup, and a
    // capture set up afterwards would count zero and call that a pass.
    const capture = captureStdio();
    try {
      context = await createMailContext({
        databaseUrl: url(),
        // No `SMTP_*` — the unconfigured state, and the real
        // `NodemailerTransport` deciding it is unconfigured.
        useRealTransport: true,
        logger: new ConsoleLogger(),
      });
      await resetMailTables(context.prisma);
      // **Explicitly without a mail server of its own** (ADR-0023): that is
      // the state this file measures, and since inheritance is gone it has to
      // be stated instead of being the default.
      const tenantId = await createMailTenant(
        context.prisma,
        'Organisation Alpha',
        null,
      );
      await enqueueMail(context.prisma, { tenantId });

      for (let round = 0; round < WORKER_RUNS; round += 1) {
        const run = await context.worker.runOnce();
        // Nothing is ever attempted while there is no mail server.
        expect(run.attempted).toBe(0);
      }
    } finally {
      capture.restore();
    }

    // Read after restoring: the capture keeps what it collected, and doing it
    // here means one `finally` with one job.
    const output = capture.text();
    expect(output).toContain(MAIL_NOT_CONFIGURED_STARTUP_WARNING);
    // The count is what matters here. „sagt es beim Start **einmal** deutlich" is
    // not met by a line printed per delivery attempt — and a `toContain` would
    // not notice the difference.
    expect(output.split(MAIL_NOT_CONFIGURED_STARTUP_WARNING)).toHaveLength(2);
  });
});
