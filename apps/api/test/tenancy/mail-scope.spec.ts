import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantScope } from '../../src/tenancy/tenant-scope';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { createTestApp, type TestApp } from '../support/create-test-app';
import { createTenant, type TenantFixture } from '../support/fixtures';

/**
 * The `ScopedNotificationDelegate` and `ScopedMailLogDelegate` of
 * `TenantScope`, against a real PostgreSQL
 * database — and, for `mail_log`, against the fact that **nothing underneath
 * them catches a mistake**.
 *
 * `form_version` and `response` carry the composite foreign key
 * `(form_id, tenant_id)`, so a forgotten tenant binding there would still be
 * refused by the database. `mail_log` has no such key, so
 * `ScopedMailLogDelegate` is the only tenant boundary that table has. That is
 * what this file is about: every case here is the **forbidden** one, because a
 * test that only shows an organisation reading its own rows stays green against a
 * delegate with no binding at all.
 *
 * The full permission matrix of the mail log routes belongs to
 * `mail-log.spec.ts`; this file covers the tenant-scope seam beneath it.
 */

const SETUP_TIMEOUT_MS = 180_000;

describe('mail scope (tenant boundary of the delegates)', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let prisma: PrismaService;

  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaFormId: string;
  let betaFormId: string;
  let betaNotificationId: string;
  let betaMailLogId: string;

  /** The scope an ALPHA request would be given. Never sees BETA. */
  function alphaScope(): TenantScope {
    return new TenantScope(prisma, alpha.id);
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
    prisma = testApp.prisma;

    alpha = await createTenant(prisma, 'ALPHA');
    beta = await createTenant(prisma, 'BETA');

    const alphaForm = await prisma.form.create({
      data: {
        tenantId: alpha.id,
        title: 'Anmeldung ALPHA',
        draftSchema: { pages: [] },
        publicSlug: 'slug-alpha-mail-scope',
      },
    });
    alphaFormId = alphaForm.id;

    const betaForm = await prisma.form.create({
      data: {
        tenantId: beta.id,
        title: 'Anmeldung BETA',
        draftSchema: { pages: [] },
        publicSlug: 'slug-beta-mail-scope',
      },
    });
    betaFormId = betaForm.id;

    const betaNotification = await prisma.notification.create({
      data: {
        tenantId: beta.id,
        formId: betaFormId,
        name: 'BETA-Bestätigung',
        subject: 'BETA Betreff',
        body: 'BETA Text',
        recipients: [{ kind: 'literal', address: 'beta-buero@beta.example' }],
      },
    });
    betaNotificationId = betaNotification.id;

    const betaMailLog = await prisma.mailLog.create({
      data: {
        tenantId: beta.id,
        formId: betaFormId,
        notificationId: betaNotificationId,
        recipient: 'beta-teilnehmer@beta.example',
        subject: 'BETA Betreff',
        status: 'failed',
        attempts: 5,
        lastError: 'BETA konnte nicht zugestellt werden',
      },
    });
    betaMailLogId = betaMailLog.id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await database?.release();
  });

  describe('ScopedNotificationDelegate', () => {
    it('does not hand a foreign notification out by id', async () => {
      expect(
        await alphaScope().notifications.findById(betaNotificationId),
      ).toBe(null);
    });

    /**
     * The form id is a caller parameter and the tenant is not — so naming
     * another organisation's form has to come back empty rather than come back with its
     * notifications.
     */
    it('does not list the notifications of a foreign form', async () => {
      expect(
        await alphaScope().notifications.findManyOfForm(betaFormId),
      ).toEqual([]);
    });

    it('neither updates nor deletes a foreign notification', async () => {
      const scope = alphaScope();
      expect(
        await scope.notifications.update(betaNotificationId, {
          name: 'übernommen',
          triggers: ['submit'],
          format: 'text',
          toSubmitter: true,
          recipients: [],
          subject: 'übernommen',
          body: 'übernommen',
          replyTo: null,
          active: false,
        }),
      ).toBe(false);
      expect(await scope.notifications.remove(betaNotificationId)).toBe(false);

      // The row is untouched — „returned false" and „did nothing" are not the
      // same statement, and only the second one is the guarantee.
      const stored = await prisma.notification.findUniqueOrThrow({
        where: { id: betaNotificationId },
      });
      expect(stored.name).toBe('BETA-Bestätigung');
      expect(stored.active).toBe(true);
    });

    it('creates under its own tenant, and only there', async () => {
      const created = await alphaScope().notifications.create(alphaFormId, {
        name: 'ALPHA-Bestätigung',
        triggers: ['submit'],
        format: 'html',
        toSubmitter: false,
        recipients: [],
        subject: 'ALPHA',
        body: 'ALPHA',
        replyTo: null,
        active: true,
      });
      expect(created.tenantId).toBe(alpha.id);

      // The counter-check that makes the one above mean something: BETA's scope
      // must not see what ALPHA just wrote.
      const seenByBeta = await new TenantScope(
        prisma,
        beta.id,
      ).notifications.findById(created.id);
      expect(seenByBeta).toBe(null);
    });
  });

  describe('ScopedMailLogDelegate', () => {
    /**
     * The whole payload is searched, not the columns a view happens to show —
     * so in as many words, because a leak through an
     * unrendered field is still a leak.
     */
    it('shows no trace of a foreign log line', async () => {
      const entries = await alphaScope().mailLog.findMany();
      const serialised = JSON.stringify(entries);
      for (const trace of [
        betaMailLogId,
        beta.id,
        betaFormId,
        betaNotificationId,
        'beta-teilnehmer@beta.example',
        'BETA Betreff',
        'BETA konnte nicht zugestellt werden',
      ]) {
        expect(serialised).not.toContain(trace);
      }
    });

    it('does not hand a foreign log line out by id', async () => {
      expect(await alphaScope().mailLog.findById(betaMailLogId)).toBe(null);
    });

    /**
     * The KPI tiles are counted in the database over the whole tenant, so a
     * missing binding would show up here as a number rather than as a row —
     * which is the version nobody notices.
     */
    it('counts nothing of another organisation', async () => {
      expect(await alphaScope().mailLog.counts()).toEqual({
        total: 0,
        sent: 0,
        failed: 0,
        queued: 0,
      });
      expect(await new TenantScope(prisma, beta.id).mailLog.counts()).toEqual({
        total: 1,
        sent: 0,
        failed: 1,
        queued: 0,
      });
    });

    /**
     * „↻ Erneut" on a stranger's row: refused, and — the half that matters —
     * the row keeps its status. A `requeue` without the tenant in its `where`
     * would answer `true` here and hand another organisation's mail back to the worker.
     */
    it('refuses to requeue a foreign log line, and leaves it alone', async () => {
      expect(
        await alphaScope().mailLog.requeue(betaMailLogId, new Date()),
      ).toBe(false);

      const stored = await prisma.mailLog.findUniqueOrThrow({
        where: { id: betaMailLogId },
      });
      expect(stored.status).toBe('failed');
      expect(stored.attempts).toBe(5);
    });

    it('requeues its own row, resetting the attempt counter', async () => {
      const own = await prisma.mailLog.create({
        data: {
          tenantId: alpha.id,
          formId: alphaFormId,
          recipient: 'alpha@alpha.example',
          subject: 'ALPHA Betreff',
          status: 'failed',
          attempts: 5,
          lastError: 'abgelehnt',
        },
      });
      const now = new Date('2026-07-28T12:00:00.000Z');

      expect(await alphaScope().mailLog.requeue(own.id, now)).toBe(true);

      const stored = await prisma.mailLog.findUniqueOrThrow({
        where: { id: own.id },
      });
      expect(stored.status).toBe('queued');
      // Zero, not „one less": on a row that used up its attempts, a retry that
      // only recoloured the status would be a click without effect.
      expect(stored.attempts).toBe(0);
      expect(stored.nextAttemptAt?.toISOString()).toBe(now.toISOString());
      // The reason stays readable until the next result replaces it.
      expect(stored.lastError).toBe('abgelehnt');
    });
  });
});
