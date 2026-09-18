import 'reflect-metadata';

import {
  ACK_DURATION_MS,
  type ApiEnv,
  type OpsStatus,
} from '@formsache/shared';
import { OpsMetric } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { JobRunService } from '../../src/observability/job-run.service';
import { OpsAcknowledgementService } from '../../src/observability/ops-acknowledgement.service';
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
 * **Eine quittierte Kennzahl schweigt** (ADR-0016, Fortschreibung 2026-09-16).
 *
 * Der Wächter kappte den Lärm bisher nur auf vier Mails am Tag je Kennzahl —
 * und zwar bis die Ursache weg war. Für einen bekannten Fall, der am Freitag
 * behoben wird, ist das die Alarmmüdigkeit, gegen die die Wiederholungssperre
 * eigentlich gebaut war.
 *
 * Was hier steht, hängt an der Datenbank: dass die Stille kommt, dass sie von
 * **selbst wieder aufhört** und dass sie einen zweiten, unabhängigen Ausbruch
 * nicht mitverschluckt. Die Route und ihr Wächter stehen in
 * `test/observability/ops-acknowledgement-route.spec.ts`.
 *
 * *Gegenprobe:* die Quittierungsprüfung aus `due()` entfernen → der zweite Fall
 * wird rot, und ein Betreiber bekäme seine Mails weiter.
 */
describe('eine quittierte Kennzahl', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let clock: MutableClock;
  let sent: { subject: string }[];
  let watchman: OpsAlertService;
  let acknowledgements: OpsAcknowledgementService;
  let userId: string;

  /** Der Zustand, der genau eine Schwelle reißt: die Warteschlange steht 90 Minuten. */
  let stuck = true;

  const status = (): OpsStatus => ({
    version: '1.0.0',
    observedAt: clock.now().toISOString(),
    mailQueue: {
      queued: stuck ? 3 : 0,
      failed: 0,
      failedRecently: 0,
      oldestQueuedAt: stuck
        ? new Date(clock.now().getTime() - 90 * 60_000).toISOString()
        : null,
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
    await prisma.user.deleteMany({});
    await prisma.systemSetting.upsert({
      where: { id: 'x' },
      create: { id: 'x', opsAlertEmail: 'betrieb@example.org' },
      update: { opsAlertEmail: 'betrieb@example.org' },
    });
    const operator = await prisma.user.create({
      data: {
        email: 'betrieb@example.org',
        name: 'Betriebsleitung',
        isSuperadmin: true,
      },
      select: { id: true },
    });
    userId = operator.id;

    clock = new MutableClock(new Date('2026-09-16T12:00:00.000Z'));
    sent = [];
    stuck = true;

    const statusService = {
      read: () => Promise.resolve(status()),
    } as unknown as OpsStatusService;
    const transport = {
      send: (mail: { subject: string }) => {
        sent.push({ subject: mail.subject });
        return Promise.resolve();
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
    const publicUrls = {
      installationBaseUrl: () => Promise.resolve(null),
    } as unknown as PublicUrlService;

    watchman = new OpsAlertService(
      { OPS_ALERT_INTERVAL_MS: 0 } as unknown as ApiEnv,
      prisma,
      clock,
      statusService,
      transport,
      identities,
      new JobRunService(prisma, clock),
      publicUrls,
    );
    acknowledgements = new OpsAcknowledgementService(
      prisma,
      clock,
      statusService,
    );
  });

  it('meldet sich ohne Quittierung nach Ablauf der Sperre erneut', async () => {
    // Der Boden unter allem Weiteren: ohne diesen Fall belegte „schweigt"
    // nichts — eine Kennzahl, die ohnehin nie ein zweites Mal meldet, wirkt
    // quittiert.
    await watchman.runOnce();
    clock.advance(ALERT_REPEAT_SUPPRESSION_MS);
    await watchman.runOnce();

    expect(sent).toHaveLength(2);
  });

  it('schweigt für die gewählte Frist', async () => {
    await watchman.runOnce();
    await acknowledgements.acknowledge(
      'mail_queue_age',
      { duration: 'day' },
      userId,
    );

    // Die Wiederholungssperre wäre längst abgelaufen.
    clock.advance(ALERT_REPEAT_SUPPRESSION_MS);
    await watchman.runOnce();

    expect(sent).toHaveLength(1);
  });

  it('meldet wieder, sobald die Frist abgelaufen ist', async () => {
    await acknowledgements.acknowledge(
      'mail_queue_age',
      { duration: 'day' },
      userId,
    );
    clock.advance(ACK_DURATION_MS.day + 1);
    await watchman.runOnce();

    expect(sent).toHaveLength(1);
    // Der Lauf räumt die abgelaufene Quittierung zugleich weg — eine Zeile,
    // die „quittiert" sagt und nichts mehr stillstellt, wäre eine Unwahrheit
    // in der Ansicht.
    const row = await prisma.opsAlert.findUnique({
      where: { metric: OpsMetric.mail_queue_age },
    });
    expect(row?.acknowledgedAt).toBeNull();
  });

  it('schweigt „bis auf Weiteres" auch nach dreißig Tagen', async () => {
    await acknowledgements.acknowledge(
      'mail_queue_age',
      { duration: 'open' },
      userId,
    );
    clock.advance(30 * 24 * 60 * 60 * 1000);
    await watchman.runOnce();

    expect(sent).toStrictEqual([]);
  });

  /**
   * ⚠️ **Der Fall, für den die Quittierung ein Vorfall ist und kein Schalter.**
   *
   * Erholt sich die Kennzahl, verfällt die Quittierung — der nächste Ausbruch
   * ist ein neuer Vorfall und meldet sich. Ohne das wäre „bis auf Weiteres"
   * ein dauerhaft blinder Fleck.
   */
  it('verfällt, sobald die Kennzahl wieder unter ihrer Schwelle liegt', async () => {
    await acknowledgements.acknowledge(
      'mail_queue_age',
      { duration: 'open' },
      userId,
    );

    stuck = false;
    await watchman.runOnce();
    expect(
      (
        await prisma.opsAlert.findUnique({
          where: { metric: 'mail_queue_age' },
        })
      )?.acknowledgedAt,
    ).toBeNull();

    // Derselbe Rückstau, ein paar Tage später: ein neuer Vorfall, und er meldet
    // sich.
    stuck = true;
    clock.advance(ALERT_REPEAT_SUPPRESSION_MS);
    await watchman.runOnce();
    expect(sent).toHaveLength(1);
  });

  /**
   * Die Erholung beendet die **Quittierung**, nicht die Wiederholungssperre.
   *
   * Sonst meldete eine um ihre Schwelle pendelnde Kennzahl bei jedem Lauf —
   * also alle fünf Minuten. Genau der Lärm, gegen den der Wächter gebaut ist.
   */
  it('setzt mit der Erholung nicht die Wiederholungssperre zurück', async () => {
    await watchman.runOnce();
    expect(sent).toHaveLength(1);

    stuck = false;
    await watchman.runOnce();
    stuck = true;
    clock.advance(5 * 60_000);
    await watchman.runOnce();

    expect(sent).toHaveLength(1);
  });

  it('nimmt die Quittierung auf Zuruf zurück', async () => {
    await acknowledgements.acknowledge(
      'mail_queue_age',
      { duration: 'open' },
      userId,
    );
    await acknowledgements.release('mail_queue_age');
    await watchman.runOnce();

    expect(sent).toHaveLength(1);
  });

  /**
   * Eine Quittierung gilt **einer** Kennzahl. Zwei gleichzeitig gerissene
   * Schwellen sind zwei Vorfälle — sonst legte ein Klick die halbe Überwachung
   * still.
   */
  it('stellt nur die quittierte Kennzahl still', async () => {
    await acknowledgements.acknowledge(
      'storage_full',
      { duration: 'open' },
      userId,
    );
    await watchman.runOnce();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain('Post bleibt liegen');
  });

  it('merkt sich Frist, Person und Begründung', async () => {
    await acknowledgements.acknowledge(
      'mail_queue_age',
      { duration: 'week', note: 'Mailserver zieht am Freitag um' },
      userId,
    );

    const row = await prisma.opsAlert.findUnique({
      where: { metric: OpsMetric.mail_queue_age },
      include: { acknowledgedBy: { select: { name: true } } },
    });
    expect(row?.acknowledgedUntil?.toISOString()).toBe(
      new Date(clock.now().getTime() + ACK_DURATION_MS.week).toISOString(),
    );
    expect(row?.acknowledgedBy?.name).toBe('Betriebsleitung');
    expect(row?.acknowledgedNote).toBe('Mailserver zieht am Freitag um');
    // Quittiert, aber noch nie gemeldet: die Zeile entstand hier, nicht im
    // Versand.
    expect(row?.lastSentAt).toBeNull();
  });
});
