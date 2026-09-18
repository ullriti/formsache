import 'reflect-metadata';

import { JobKind } from '@prisma/client';
import type { ApiEnv, OpsStatus } from '@formsache/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { JobRunService } from '../../src/observability/job-run.service';
import {
  ALERT_REPEAT_SUPPRESSION_MS,
  OpsAlertService,
} from '../../src/observability/ops-alert.service';
import type { OpsStatusService } from '../../src/observability/ops-status.service';
import type { PublicUrlService } from '../../src/common/public-url/public-url.service';
import type { MailIdentityService } from '../../src/mail/mail-identity.service';
import type { MailTransport } from '../../src/mail/mail-transport';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { MutableClock } from '../mail/mail-test-context';

/**
 * **The alert goes out directly, does not repeat endlessly, and its
 * own failure is visible** (ADR-0016).
 *
 * The thresholds themselves stand in `ops-alert.spec.ts`; here stands what
 * hangs on the database.
 *
 * *Reproduction:* remove the repeat suppression → the second case turns red,
 * and an installation whose queue stands for a week would send the same mail
 * every five minutes.
 */
describe('Der Wächter verschickt ', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let clock: MutableClock;
  let sent: {
    to: string;
    subject: string;
    text: string;
    html: string | undefined;
  }[];
  let service: OpsAlertService;

  /** A status that breaks exactly one threshold (queue, 90 min). */
  const noisy = (): OpsStatus => ({
    version: '1.0.0',
    observedAt: clock.now().toISOString(),
    mailQueue: {
      queued: 3,
      failed: 0,
      failedRecently: 0,
      oldestQueuedAt: new Date(
        clock.now().getTime() - 90 * 60_000,
      ).toISOString(),
    },
    jobs: [],
    storage: { usedBytes: 0, files: 0, usedFraction: 0.1 },
    ai: { calls: 0, failed: 0, failureRate: null, byModel: [] },
    alerts: [],
  });

  beforeAll(async () => {
    db = await acquireTestDatabase();
    prisma = new PrismaService({ DATABASE_URL: db.url } as never);
    await prisma.onModuleInit();
  }, 120_000);

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await db.release();
  }, 120_000);

  beforeEach(async () => {
    await prisma.opsAlert.deleteMany({});
    await prisma.jobRun.deleteMany({});
    // ⚠️ **This file sets the column directly — and that is admissible here,
    // since there is a write path.** Up to the review gate it was *not*:
    // `ops_alert_email` had no write path at all in the product, the watchman
    // reached nobody on any real installation, and this green test
    // proved only its own setup. The path is now proved in
    // `test/system-settings/mail-admin.spec.ts` over the **route**
    // (`PUT /api/admin/system-settings/mail` behind `SuperadminGuard`); here
    // it is about the delivery when an address stands.
    await prisma.systemSetting.upsert({
      where: { id: 'x' },
      create: { id: 'x', opsAlertEmail: 'betrieb@example.org' },
      update: { opsAlertEmail: 'betrieb@example.org' },
    });

    clock = new MutableClock(new Date('2026-08-11T12:00:00.000Z'));
    sent = [];
    service = build({ status: noisy });
  });

  /** The service with doubles for everything outside the database. */
  function build(options: {
    status: () => OpsStatus;
    send?: () => Promise<void>;
    /** > 0 starts the timer — and with it the immediate first run. */
    intervalMs?: number;
    /** The base address of the installation; if it is missing, there is no link. */
    baseUrl?: string;
  }): OpsAlertService {
    const transport = {
      send: (mail: {
        to: string;
        subject: string;
        text: string;
        html?: string;
      }) => {
        sent.push({
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        });
        return options.send?.() ?? Promise.resolve();
      },
    } as unknown as MailTransport;
    const identities = {
      resolve: () =>
        Promise.resolve({
          kind: 'send' as const,
          source: 'system' as const,
          block: {
            host: 'localhost',
            port: 25,
            secure: false,
            auth: null,
            from: 'a@b.c',
          },
        }),
    } as unknown as MailIdentityService;
    const status = {
      read: () => Promise.resolve(options.status()),
    } as unknown as OpsStatusService;
    /*
     * Only `installationBaseUrl` — and that is the statement: an operations
     * message belongs to the installation, so this service must not even ask
     * the chain over an organisation in the first place. Whoever built
     * `resolveBaseUrl` in here would get a `TypeError` in these cases, not a green result.
     */
    const publicUrls = {
      installationBaseUrl: () => Promise.resolve(options.baseUrl ?? null),
    } as unknown as PublicUrlService;

    return new OpsAlertService(
      { OPS_ALERT_INTERVAL_MS: options.intervalMs ?? 0 } as unknown as ApiEnv,
      prisma,
      clock,
      status,
      transport,
      identities,
      new JobRunService(prisma, clock),
      publicUrls,
    );
  }

  it('verschickt einen Alarm, wenn eine Schwelle gerissen ist', async () => {
    const count = await service.runOnce();

    expect(count).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('betrieb@example.org');
    expect(sent[0]?.subject).toContain('Post bleibt liegen');
  });

  /**
   * **An operations message too carries the link into the system** — and namely the
   * one of the **installation**: it belongs to no organisation, and
   * `tenant.public_base_url` is set by whoever holds `can_manage_settings` of an
   * arbitrary organisation (ADR-0023).
   *
   * Both versions, because the plain-text version is the half that gets
   * forgotten — and because it is the only one that an operator reads in the
   * terminal or in a text client.
   *
   * *Counter-check:* replace `wrapMailBody` in `OpsAlertService.send` with the
   * bare body → red.
   */
  it('trägt in beiden Fassungen die Fußzeile mit der Adresse der Installation', async () => {
    const linked = build({
      status: noisy,
      baseUrl: 'https://formsache.example',
    });

    await linked.runOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('Zu Formsache: https://formsache.example');
    expect(sent[0]?.html).toContain('href="https://formsache.example"');
    // No organisation in the footer of an operations message.
    expect(sent[0]?.text).not.toContain('Formulare von');
  });

  /**
   * **A mail without a link is better than one with a broken one** — and an
   * operations message that failed at a missing base address would be the
   * one mail whose absence nobody notices.
   */
  it('verschickt auch ohne Basis-Adresse — dann ohne Link', async () => {
    await service.runOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('Diese E-Mail wurde automatisch erzeugt.');
    expect(sent[0]?.text).not.toContain('Zu Formsache:');
    expect(sent[0]?.html).not.toContain('<a href');
  });

  it('wiederholt dieselbe Kennzahl nicht — bis die Sperre abgelaufen ist', async () => {
    await service.runOnce();
    // Five minutes later the same queue is still standing.
    clock.advance(5 * 60_000);
    await service.runOnce();

    expect(sent).toHaveLength(1);

    // After the suppression has expired it reports again: an outage that lasts
    // days should not drop out of sight after the first mail.
    clock.advance(ALERT_REPEAT_SUPPRESSION_MS);
    await service.runOnce();
    expect(sent).toHaveLength(2);
  });

  it('hält die Sperre in der **Datenbank**, nicht im Prozess', async () => {
    await service.runOnce();

    // A restart — exactly the case that a suppression in main memory does not
    // survive, and the reason why it stands in a table: an installation rolled
    // out anew daily would otherwise send the alert anew every day.
    const afterRedeploy = build({ status: noisy });
    await afterRedeploy.runOnce();

    expect(sent).toHaveLength(1);
    expect(await prisma.opsAlert.count()).toBe(1);
  });

  it('schweigt ohne Empfängeradresse, statt zu scheitern', async () => {
    await prisma.systemSetting.update({
      where: { id: 'x' },
      data: { opsAlertEmail: null },
    });

    await expect(service.runOnce()).resolves.toBe(0);
    expect(sent).toStrictEqual([]);
  });

  /**
   * ⚠️ **The bookkeeping of the watchman about its *own* run** (ADR-0016) — and until today it was unproved.
   *
   * The existing case below checked that `ops_alert` *stands* in the `JobKind`
   * enumeration. That is a statement about an enum, not about the service: one
   * could remove `jobRuns.record(...)` from `runTick`, and **no** test
   * turned red. Exactly the gap against which this project builds its watchmen.
   *
   * What is driven is therefore the **timer path** (`onModuleInit` triggers
   * immediately) instead of `runOnce()`: the row arises in `runTick`, and a test
   * that calls `runOnce()` directly goes past it — it was the cause of
   * the gap standing open for so long.
   *
   * *Reproduction:* replace `jobRuns.record(…)` in `runTick` with a direct
   * `this.runOnce()` → both cases red.
   */
  it('schreibt eine job_run-Zeile über seinen eigenen Lauf', async () => {
    const scheduled = build({ status: noisy, intervalMs: 60_000 });
    scheduled.onModuleInit();
    // `onModuleDestroy` waits for the running tick — that is why no `sleep`
    // stands here that sometimes suffices and sometimes does not.
    await scheduled.onModuleDestroy();

    const rows = await prisma.jobRun.findMany({
      where: { job: JobKind.ops_alert },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('ok');
    // The number is the **sent** alert, not the broken threshold.
    expect(rows[0]?.itemCount).toBe(1);
    expect(rows[0]?.errorClass).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('bucht auch sein eigenes Scheitern — mit der Fehlerklasse, ohne die Meldung', async () => {
    const failing = build({ status: noisy, intervalMs: 60_000 });
    // The operations status is the first thing the run touches; if it fails,
    // the whole watchman fails — exactly the case that nobody would see if it
    // were not booked.
    const boom = new Error('betrieb@example.org ist nicht erreichbar');
    Object.defineProperty(failing, 'status', {
      value: { read: () => Promise.reject(boom) },
    });

    failing.onModuleInit();
    await failing.onModuleDestroy();

    const rows = await prisma.jobRun.findMany({
      where: { job: JobKind.ops_alert },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('failed');
    expect(rows[0]?.errorClass).toBe('Error');
    // ⚠️ The **class**, never the message: an address stands in it here.
    expect(JSON.stringify(rows[0])).not.toContain('betrieb@example.org');
    expect(sent).toStrictEqual([]);
  });

  it('schweigt an einer ruhigen Installation', async () => {
    const quiet = build({
      status: () => ({
        ...noisy(),
        mailQueue: {
          queued: 0,
          failed: 0,
          failedRecently: 0,
          oldestQueuedAt: null,
        },
      }),
    });

    await expect(quiet.runOnce()).resolves.toBe(0);
    expect(sent).toStrictEqual([]);
  });
});

describe('Der Wächter selbst kann ausfallen ', () => {
  it('kennt `ops_alert` als `JobKind`', () => {
    // An alert path whose own failure nobody sees is the quietest
    // of all gaps. That is why the watchman itself stands in the bookkeeping,
    // although it cleans up nothing.
    //
    // ⚠️ **This case alone did not prove that.** It checks the enumeration,
    // not the service — one could remove the booking from `runTick`, and it
    // stayed green. What proves it stands two describe blocks further up
    // („schreibt eine job_run-Zeile", „bucht auch sein eigenes Scheitern");
    // here it stays as what it is: the precondition for the row being able
    // to be written *at all*.
    expect(Object.values(JobKind)).toContain('ops_alert');
  });
});
