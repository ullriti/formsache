import 'reflect-metadata';

import { OpsStatusService } from '../../src/observability/ops-status.service';
import { JobKind } from '@prisma/client';
import { parseOpsStatus } from '@formsache/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import request from 'supertest';

import { createTenant, createUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/create-test-app';
import { cookieHeader, openSession } from '../support/http';

const PASSWORD = 'change-me-locally';
const OPS = '/api/admin/ops';

/**
 * **The Betriebsstatus is a superadmin matter** (ADR-0016).
 *
 * The **first** case is the evidence, not the second: a route that counts
 * across all organisations is only proven once the forbidden access has been
 * seen to fail. Exactly this shape was real once — the AI quota
 * route answered an organisation admin **204 instead of 403, and the column
 * was written**.
 *
 * *Reproduction:* take `SuperadminGuard` off the controller → the first case
 * turns red, while the second stays green.
 */
describe('GET /api/admin/ops — der Betriebsstatus ', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenantAdmin: string;
  let superadmin: string;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    const tenant = await createTenant(testApp.prisma, 'OPS');
    const admin = await createUser(testApp.prisma, {
      email: 'Organisation-admin@ops.example',
      password: PASSWORD,
      tenants: [tenant],
    });
    tenantAdmin = await openSession(testApp, admin.id, tenant.id);

    const root = await createUser(testApp.prisma, {
      email: 'root@ops.example',
      password: PASSWORD,
      tenants: [tenant],
      isSuperadmin: true,
    });
    superadmin = await openSession(testApp, root.id, tenant.id);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  const readOps = () =>
    request(testApp.server).get(OPS).set('Cookie', cookieHeader(superadmin));

  it('weist einen Organisationsadmin mit 403 ab', async () => {
    const response = await request(testApp.server)
      .get(OPS)
      .set('Cookie', cookieHeader(tenantAdmin));
    expect(response.status).toBe(403);
  });

  it('weist einen Abruf ohne Sitzung mit 401 ab', async () => {
    const response = await request(testApp.server).get(OPS);
    expect(response.status).toBe(401);
  });

  it('antwortet dem Superadmin mit den fünf Zahlengruppen', async () => {
    const response = await readOps();
    expect(response.status).toBe(200);

    const status = parseOpsStatus(response.body);
    expect(status.version).toBe('0.0.0-test');
    // All five jobs are listed, including those that never ran — otherwise
    // „this job is missing" could not be told apart from „this job is
    // unknown".
    expect(status.jobs.map((job) => job.job).sort()).toStrictEqual(
      Object.values(JobKind).sort(),
    );
    expect(status.jobs.every((job) => job.lastSuccessAt === null)).toBe(true);
  });

  /**
   * **The alert watchdog does not walk the storage** (a review finding).
   *
   * `findBreaches` reads **only** `usedFraction` from `storage` — the number
   * from `statfs`, one call. Used bytes and file count, by contrast, arise
   * from a recursive walk with one `stat` per file, and up to this finding
   * that one ran **every five minutes** for numbers nobody read.
   *
   * It is measured at the seam, not at the runtime: `read({ inventory:
   * false })` returns `null` instead of numbers, and the fraction is there
   * nonetheless. A time measurement would be the worse watchdog — it is green
   * on an empty storage no matter what the code does.
   */
  it('erhebt das Inventar der Ablage nur, wenn jemand hinsieht', async () => {
    const service = testApp.app.get(OpsStatusService);

    const forView = await service.read();
    expect(forView.storage.usedBytes).not.toBeNull();
    expect(forView.storage.files).not.toBeNull();

    const forAlerts = await service.read({ inventory: false });
    expect(forAlerts.storage.usedBytes).toBeNull();
    expect(forAlerts.storage.files).toBeNull();
    // And the number an alert arises from is untouched: `usedFraction`
    // comes from `statfs` and is either a number or — on a file system
    // without `statfs` — `null`. What it must not be is null
    // *because* the inventory was deselected.
    //
    // What is compared is therefore the **nullness**, not the value. The two
    // calls measure a real fill level at two points in time; it moves as soon
    // as anything writes to the disk — in a full run the suite creates test
    // databases alongside. A comparison for equality was therefore
    // sporadically red (`0.8906438` against `0.8906515`) and said nothing
    // about the claim of this case anyway.
    expect(forAlerts.storage.usedFraction === null).toBe(
      forView.storage.usedFraction === null,
    );
  });

  it('zählt über **alle** Organisationen und nennt keine davon', async () => {
    const other = await createTenant(testApp.prisma, 'OPS2');
    await testApp.prisma.mailLog.createMany({
      data: [
        mailRow(other.id, 'queued'),
        mailRow(other.id, 'queued'),
        mailRow(other.id, 'failed'),
      ],
    });

    const response = await readOps();
    const status = parseOpsStatus(response.body);

    expect(status.mailQueue.queued).toBe(2);
    expect(status.mailQueue.failed).toBe(1);
    expect(status.mailQueue.oldestQueuedAt).not.toBeNull();
    // The payload carries sums. If an organisation id stood here, the
    // Betriebsstatus would be information about other organisations — and the
    // reason why it sits behind the superadmin guard would be a different one
    // than the one named.
    expect(JSON.stringify(status)).not.toContain(other.id);
    expect(JSON.stringify(status)).not.toContain('OPS2');
  });

  /**
   * **The stock and the window are two numbers** (a review finding).
   *
   * `failed` holds what the table still carries — until the 90-day retention
   * period bites. `failedRecently` counts the same thing over the last six
   * hours and is thereby the only one of the two that can go back to 0 by
   * itself; only it is fit as a basis for an alert.
   *
   * *Counter-check:* take the `failedAt` criterion out of the third count in
   * `OpsStatusService.mailQueue` → this case turns red, the others stay green.
   */
  it('zählt gescheiterte Nachrichten außerhalb des Fensters nicht mehr als „kürzlich"', async () => {
    const before = parseOpsStatus((await readOps()).body).mailQueue;

    const tenant = await createTenant(testApp.prisma, 'OPS3');
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await testApp.prisma.mailLog.createMany({
      data: [
        {
          ...mailRow(tenant.id, 'failed'),
          createdAt: sevenHoursAgo,
          failedAt: sevenHoursAgo,
        },
        { ...mailRow(tenant.id, 'failed'), failedAt: new Date() },
      ],
    });

    const after = parseOpsStatus((await readOps()).body).mailQueue;
    expect(after.failed).toBe(before.failed + 2);
    expect(after.failedRecently).toBe(before.failedRecently + 1);
  });

  /**
   * ⚠️ **The case the first version broke on**
   * (review rework, 2026-08-12).
   *
   * It counted over `created_at`, the moment of **queueing**, on the grounds
   * that between queueing and giving up lie at most the retries of a single
   * day. „↻ Erneut" refutes that: the button puts an arbitrarily old row back
   * into the queue and expressly leaves `created_at` standing (it is the sort
   * column of the mail log).
   *
   * The failure case this test stands against: the SMTP access expires, forty
   * messages fail over three days, an admin re-triggers them all after a
   * supposed repair — and they fail again. With `created_at`,
   * `failedRecently` was **0** in that situation and the alert stayed out, at
   * exactly the moment it exists for.
   *
   * *Counter-check:* replace `failedAt` by `createdAt` in `mailQueue` → this
   * case turns red, the one above stays green. **That is exactly why it stands
   * here:** the case above did not notice the wrong column.
   */
  it('zählt eine alte, neu angestoßene und erneut gescheiterte Zeile als „kürzlich"', async () => {
    const before = parseOpsStatus((await readOps()).body).mailQueue;

    const tenant = await createTenant(testApp.prisma, 'OPS4');
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    // Queued three days ago, failed back then, re-triggered today and given
    // up on again: `created_at` old, `failed_at` fresh.
    await testApp.prisma.mailLog.create({
      data: {
        ...mailRow(tenant.id, 'failed'),
        createdAt: threeDaysAgo,
        failedAt: new Date(),
      },
    });

    const after = parseOpsStatus((await readOps()).body).mailQueue;
    expect(after.failedRecently).toBe(before.failedRecently + 1);
  });

  it('unterscheidet „lief zuletzt" von „lief zuletzt **erfolgreich**"', async () => {
    const at = (iso: string): Date => new Date(iso);
    await testApp.prisma.jobRun.createMany({
      data: [
        {
          job: JobKind.file_purge,
          startedAt: at('2026-08-09T02:00:00.000Z'),
          finishedAt: at('2026-08-09T02:00:05.000Z'),
          outcome: 'ok',
          itemCount: 4,
        },
        {
          job: JobKind.file_purge,
          startedAt: at('2026-08-10T02:00:00.000Z'),
          finishedAt: at('2026-08-10T02:00:01.000Z'),
          outcome: 'failed',
          errorClass: 'PrismaClientKnownRequestError',
        },
      ],
    });

    const response = await readOps();
    const status = parseOpsStatus(response.body);
    const filePurge = status.jobs.find((job) => job.job === 'file_purge');

    // Exactly for this both numbers are there: the job **ran** yesterday and
    // last **succeeded** the day before. Anyone showing only „lief zuletzt"
    // would report an installation as healthy whose clean-up job has been
    // failing for days.
    expect(filePurge?.lastRunAt).toBe('2026-08-10T02:00:00.000Z');
    expect(filePurge?.lastSuccessAt).toBe('2026-08-09T02:00:00.000Z');
    expect(filePurge?.lastOutcome).toBe('failed');
    expect(filePurge?.lastErrorClass).toBe('PrismaClientKnownRequestError');
  });

  /**
   * **The AI consumption per model *and* version** .
   *
   * The grouping runs over **both** columns, and the case is built so that a
   * grouping over `model` alone turns red: two rows carry the same identifier
   * `mistral-large-latest` and **different** versions — exactly the situation
   * in which the provider moved its alias on in the middle of the month. Over
   * `model` alone that would look like one row with four calls.
   *
   * The third row is the opposite direction: `NULL` in the version must
   * swallow no group and invent no 0 — `_sum` over nothing but `NULL` stays
   * `null`, because „nothing consumed" and „the provider said nothing" are
   * two statements.
   *
   * *Reproduction:* `by: ['model']` instead of `by: ['model',
   * 'modelResolved']` → this case turns red and reports two rows instead of
   * three.
   */
  it('schlüsselt den KI-Verbrauch nach Kennung und Fassung auf', async () => {
    const tenant = await createTenant(testApp.prisma, 'OPSAI');
    const user = await createUser(testApp.prisma, {
      email: 'ki@ops.example',
      password: PASSWORD,
      tenants: [tenant],
    });
    const row = (
      model: string,
      modelResolved: string | null,
      inputTokens: number | null,
    ) => ({
      tenantId: tenant.id,
      userId: user.id,
      provider: 'mistral' as const,
      model,
      modelResolved,
      outcome: 'ok' as const,
      inputTokens,
      outputTokens: inputTokens,
    });

    await testApp.prisma.aiUsage.createMany({
      data: [
        row('mistral-large-latest', 'mistral-large-2512', 100),
        row('mistral-large-latest', 'mistral-large-2512', 200),
        row('mistral-large-latest', 'mistral-large-2604', 7),
        row('claude-opus-5', null, null),
      ],
    });

    const status = parseOpsStatus((await readOps()).body);
    expect(status.ai.byModel).toStrictEqual([
      {
        model: 'mistral-large-latest',
        resolved: 'mistral-large-2512',
        calls: 2,
        inputTokens: 300,
        outputTokens: 300,
      },
      {
        model: 'claude-opus-5',
        resolved: null,
        calls: 1,
        inputTokens: null,
        outputTokens: null,
      },
      {
        model: 'mistral-large-latest',
        resolved: 'mistral-large-2604',
        calls: 1,
        inputTokens: 7,
        outputTokens: 7,
      },
    ]);
  });
});

function mailRow(tenantId: string, status: 'queued' | 'failed') {
  return {
    tenantId,
    status,
    recipient: 'empfaenger@example.org',
    subject: 'Betreff',
    bodyText: 'Rumpf',
    attempts: 0,
  };
}
