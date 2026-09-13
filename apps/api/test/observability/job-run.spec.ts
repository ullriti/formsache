import 'reflect-metadata';

import { JobKind } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { JobRunService } from '../../src/observability/job-run.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { MutableClock } from '../mail/mail-test-context';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';

/**
 * **Every background run keeps a record — and a run that *fails to happen* can
 * be recognised by it** (ADR-0016).
 *
 * The case this is about is the third one below. In the past a failed purge
 * wrote a `logger.error` line into a container stream that nobody keeps; a
 * purge that **never starts** wrote nothing at all. The second one is the more
 * expensive one and has already been real once: the
 * purge armed only a 24-hour interval at startup, and an installation rolled
 * out anew every day would therefore never have deleted anything — with the
 * application running, without a single conspicuous number.
 *
 * *Reproduction:* move the writing of the line into the `catch` branch (that
 * is, only record on success) → the failure case turns red. Set the timestamp
 * at the query instead of at the run → the age case turns red, **and it does
 * so silently**: the installation would look fresh forever.
 */
describe('job_run — die Buchführung über die Hintergrundläufe', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let clock: MutableClock;
  let service: JobRunService;

  beforeAll(async () => {
    db = await acquireTestDatabase();
    prisma = new PrismaService({ DATABASE_URL: db.url } as never);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await db.release();
  });

  beforeEach(async () => {
    await prisma.jobRun.deleteMany({});
    clock = new MutableClock(new Date('2026-08-11T10:00:00.000Z'));
    service = new JobRunService(prisma, clock);
  });

  it('schreibt bei Erfolg eine Zeile mit der Zahl der behandelten Elemente', async () => {
    const returned = await service.record(JobKind.file_purge, () =>
      Promise.resolve(7),
    );

    expect(returned).toBe(7);
    const rows = await prisma.jobRun.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      job: JobKind.file_purge,
      outcome: 'ok',
      itemCount: 7,
      errorClass: null,
    });
  });

  it('schreibt bei Fehlschlag eine Zeile — mit Fehlerklasse und **ohne** Meldungstext', async () => {
    const boom = new TypeError(
      'delete from response where tenant_id = … (Organisation „Alte Verein", kontakt@example.org)',
    );

    await expect(
      service.record(JobKind.retention_purge, () => Promise.reject(boom)),
    ).rejects.toThrow(boom);

    const rows = await prisma.jobRun.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('failed');
    // The class, never the message. The invented message above
    // deliberately carries an organisation name and an address: were any of it
    // to be found in the row, the record keeping itself would be a data leak.
    expect(rows[0]?.errorClass).toBe('TypeError');
    const serialised = JSON.stringify(rows[0]);
    expect(serialised).not.toMatch(/Alte Verein|example\.org|tenant_id/);
  });

  it('lässt den nächsten Lauf trotzdem laufen — Scheitern ist sichtbar, nicht blockierend', async () => {
    await expect(
      service.record(JobKind.mail_worker, () => Promise.reject(new Error('x'))),
    ).rejects.toThrow();
    await service.record(JobKind.mail_worker, () => Promise.resolve(3));

    const rows = await prisma.jobRun.findMany({
      orderBy: { startedAt: 'asc' },
    });
    expect(rows.map((row) => row.outcome)).toStrictEqual(['failed', 'ok']);
  });

  /*
   * ⚠️ **Here stood „datiert den Lauf, nicht das Abfragen", and the case was
   * tautological** — it computed the age from the same `MutableClock` that
   * `startedAt` came from as well; the result was by construction the
   * expected number. The case directly below has always written down that
   * this very promise once stayed green when the stamp was set at *writing*
   * time. A review resolved the contradiction: deleted, because
   * „stempelt den Beginn" covers the property **for real**.
   */

  it('stempelt den **Beginn** des Laufs, nicht sein Ende', async () => {
    // ⚠️ This case grew out of a reproduction that **stayed green**.
    // A case above it („datiert den Lauf, nicht das Abfragen") stayed green when
    // `startedAt` was set at the *writing* of the row instead of at the start —
    // because in that case no time passes between start and writing. So it
    // described an assurance that it did not check.
    //
    // Here time passes **during the run**: a purge over a hundred thousand
    // responses takes a while, and exactly then start and end drift apart.
    // „Wann lief er zuletzt" has to mean the start, otherwise a run that has
    // worked for two hours reports itself as two hours younger than it is.
    const startedAt = clock.now();

    await service.record(JobKind.retention_purge, async () => {
      clock.advance(10 * 60 * 1000);
      return Promise.resolve(2);
    });

    const row = await prisma.jobRun.findFirstOrThrow();
    expect(row.startedAt.toISOString()).toBe(startedAt.toISOString());
    expect(row.finishedAt.getTime() - row.startedAt.getTime()).toBe(
      10 * 60 * 1000,
    );
  });

  it('hält jede Lauf-Art getrennt — eine laufende Art verdeckt keine stehengebliebene', async () => {
    await service.record(JobKind.mail_worker, () => Promise.resolve(1));
    clock.advance(40 * 60 * 60 * 1000);
    await service.record(JobKind.mail_worker, () => Promise.resolve(1));

    const lastByKind = async (job: JobKind) =>
      prisma.jobRun.findFirst({
        where: { job, outcome: 'ok' },
        orderBy: { startedAt: 'desc' },
      });

    expect(await lastByKind(JobKind.mail_worker)).not.toBeNull();
    // The trash run has **never** recorded anything in this period. Without
    // the separation per kind a busy worker would look like a healthy
    // installation while the purge has been failing for days.
    expect(await lastByKind(JobKind.retention_purge)).toBeNull();
  });

  it('lässt den Lauf nicht an seiner eigenen Buchführung scheitern', async () => {
    const broken = {
      jobRun: {
        create: () => Promise.reject(new Error('table is gone')),
      },
    } as unknown as PrismaService;
    const fragile = new JobRunService(broken, clock);

    // The observation must not kill the observed: the run has done its work,
    // and broken record keeping must not turn that into a failure.
    await expect(
      fragile.record(JobKind.mail_log_purge, () => Promise.resolve(5)),
    ).resolves.toBe(5);
  });
});
