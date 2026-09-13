import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTestMailResult } from '@formsache/shared';

import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  apiPath,
  configureSystemMail,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import { createUser } from '../support/fixtures';
import { authedMutation, openSession } from '../support/http';
import { startSmtpInbox, type SmtpInbox } from '../support/smtp-inbox';

/**
 * **Die Testmail der Systemverwaltung ohne Organisation**
 * (Review-Runde 3 Nr. 12): *„Testmail sollte auch ohne Orga gehen. Dann halt
 * nicht protokolliert."*
 *
 * ## Der Zustand, den diese Datei nachstellt
 *
 * Eine frische Installation: ein Superadministrator, **keine** Organisation.
 * Genau der Zustand während der Erstinbetriebnahme — und genau der, in dem
 * man den eben eingetragenen Mailserver zum ersten Mal prüfen will.
 *
 * Bis hierher antwortete die Route 403. Nicht wegen der Berechtigung — die
 * entscheidet `SuperadminGuard` und war erteilt —, sondern weil
 * `TenantScopeGuard` einen Bereich verlangte, den es für den Protokolleintrag
 * braucht: `mail_log.tenant_id` ist `NOT NULL`.
 *
 * ## Was hier gemessen wird, und warum beides
 *
 * 1. **Die Mail geht wirklich hinaus** — gegen einen echten SMTP-Empfänger,
 *    nicht gegen eine Attrappe. Ein Test, der nur die 200 prüft, ließe genau
 *    den Fehler durch, um den es geht: eine Route, die freundlich antwortet
 *    und nichts tut.
 * 2. **Und es entsteht keine Zeile.** Das ist die andere Hälfte der
 *    Entscheidung und die, die still falsch werden könnte: würde hier doch
 *    eine `mail_log`-Zeile geschrieben, hinge sie an einer erfundenen
 *    Organisation — und damit an der Spalte, die die Mandantentrennung des
 *    Versandprotokolls trägt.
 *
 * ## Warum eine eigene Datei
 *
 * Wegen `TEST_MAIL_RATE_LIMIT` — zehn Versuche je Minute und Herkunft.
 * `test-mail-recipient.spec.ts` rechnet sein Budget in einem eigenen Absatz
 * vor; jeder Fall, den man dort hinzufügt, nimmt einen der zehn weg. Eine
 * eigene Anwendung bringt ihren eigenen Zähler mit — dieselbe Begründung, mit
 * der jene Datei selbst entstanden ist.
 */

const SETUP_TIMEOUT_MS = 180_000;
const SYSTEM_TEST_MAIL_PATH = '/admin/system-settings/mail/test';

describe('Testmail der Systemverwaltung ohne Organisation', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let prisma: PrismaService;
  let inbox: SmtpInbox | undefined;

  let superadminSession: string;
  let superadminEmail: string;

  function app(): TestApp {
    if (testApp === undefined) {
      throw new Error('no test app');
    }
    return testApp;
  }

  function box(): SmtpInbox {
    if (inbox === undefined) {
      throw new Error('no smtp inbox');
    }
    return inbox;
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
    prisma = testApp.prisma;
    inbox = await startSmtpInbox();

    /*
      **Keine Organisation, und das ist der ganze Aufbau.** `tenants` bleibt
      leer, die Sitzung wird ohne aktive Organisation eröffnet — der Zustand
      einer Installation, die gerade ihr erstes Konto bekommen hat.
    */
    superadminEmail = `super-${randomUUID().slice(0, 8)}@installation.invalid`;
    const superadmin = await createUser(prisma, {
      email: superadminEmail,
      password: 'test-password',
      isSuperadmin: true,
    });
    superadminSession = await openSession(app(), superadmin.id, null);

    await configureSystemMail(app(), {
      smtp: {
        host: '127.0.0.1',
        port: box().port,
        secure: false,
        auth: { user: 'installation', password: 'test-password-1!' },
        from: 'post@installation.invalid',
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await inbox?.close();
    await database?.release();
  });

  it('verschickt sie — und legt dafür keine Protokollzeile an', async () => {
    expect(
      await prisma.tenant.count(),
      'Der Aufbau dieses Falls ist „keine Organisation" — sonst misst er ' +
        'etwas anderes.',
    ).toBe(0);
    const mark = box().messages.length;

    const response = await request(app().server)
      .post(apiPath(SYSTEM_TEST_MAIL_PATH))
      .set(authedMutation(superadminSession))
      .send({});

    expect(response.status).toBe(200);
    expect(parseTestMailResult(response.body as unknown)).toStrictEqual({
      recipientEmail: superadminEmail,
      status: 'sent',
      reason: null,
    });

    // Wirklich hinaus, über den Block der Installation.
    const delivered = box().messages.slice(mark);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.to).toStrictEqual([superadminEmail]);
    expect(delivered[0]?.from).toBe('post@installation.invalid');

    // Und keine Zeile — die andere Hälfte der Entscheidung.
    expect(
      await prisma.mailLog.count(),
      'Ohne Organisation darf keine Protokollzeile entstehen: sie hinge an ' +
        'einer erfundenen tenant_id.',
    ).toBe(0);
  });

  it('nimmt auch hier eine abweichende Adresse an', async () => {
    const mark = box().messages.length;
    const elsewhere = 'jemand.anderes@example.invalid';

    const response = await request(app().server)
      .post(apiPath(SYSTEM_TEST_MAIL_PATH))
      .set(authedMutation(superadminSession))
      .send({ recipientEmail: elsewhere });

    expect(response.status).toBe(200);
    expect(parseTestMailResult(response.body as unknown).recipientEmail).toBe(
      elsewhere,
    );
    expect(box().messages.slice(mark)[0]?.to).toStrictEqual([elsewhere]);
    expect(await prisma.mailLog.count()).toBe(0);
  });

  /**
   * ⚠️ **Der verbotene Fall bleibt verboten.** Dass die Route ohne
   * Organisation durchlässt, ist eine Aussage über die Ablage der Zeile und
   * **keine** über die Berechtigung: wer kein Superadministrator ist, kommt
   * hier weiterhin nicht durch — und ohne Organisation erst recht nicht
   * „ersatzweise".
   */
  it('lässt weiterhin niemanden ohne Systemverwaltung durch', async () => {
    const outsider = await createUser(prisma, {
      email: `niemand-${randomUUID().slice(0, 8)}@example.invalid`,
      password: 'test-password',
    });
    const session = await openSession(app(), outsider.id, null);
    const mark = box().messages.length;

    const response = await request(app().server)
      .post(apiPath(SYSTEM_TEST_MAIL_PATH))
      .set(authedMutation(session))
      .send({});

    expect(response.status).toBe(403);
    expect(box().messages.slice(mark)).toHaveLength(0);
  });

  /**
   * Ohne eingetragenen Mailserver wird **nichts versucht**: die Antwort ist
   * der feste Satz „nicht eingerichtet", keine Netzwerkmeldung (ADR-0013
   * Nr. 5). Steht am Ende, weil er den Systemblock wegnimmt.
   */
  it('versucht ohne eingetragenen Mailserver gar nichts', async () => {
    await configureSystemMail(app(), { smtp: null });
    const mark = box().messages.length;

    const response = await request(app().server)
      .post(apiPath(SYSTEM_TEST_MAIL_PATH))
      .set(authedMutation(superadminSession))
      .send({});

    expect(response.status).toBe(200);
    const result = parseTestMailResult(response.body as unknown);
    expect(result.status).toBe('failed');
    expect(result.reason).not.toBeNull();
    expect(box().messages.slice(mark)).toHaveLength(0);
    expect(await prisma.mailLog.count()).toBe(0);
  });
});
