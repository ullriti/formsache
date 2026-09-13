import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
 * **Jemanden in die Systemverwaltung einladen, der in keiner Organisation
 * ist** (Review-Runde 3 Nr. 13).
 *
 * ## Der Wunsch
 *
 * *„Mir kam der Gedanke bei ‚Person zur Systemverwaltung hinzufügen': dort
 * würde ich ja auch gerne jemanden einladen, der in keiner Orga ist."*
 *
 * Bis dahin konnte `POST /admin/superadmins` nur **ernennen**, wer schon ein
 * Konto hat, und ein Konto entstand immer zusammen mit einer Mitgliedschaft.
 * Wer die zweite Systemverwaltung wollte, musste die Person erst in
 * irgendeine Organisation aufnehmen — eine Mitgliedschaft, die niemand wollte.
 *
 * ## Was hier gemessen wird, und warum in dieser Reihenfolge
 *
 * 1. **Es entsteht ein Konto, und zwar ohne Mitgliedschaft.** Das ist die
 *    Zusage; `deleteHomelessAccount` trägt `isSuperadmin: false` in seinem
 *    `where`, ein solches Konto überlebt den Aufräumlauf also.
 * 2. **Die Einladung geht wirklich hinaus** — gegen einen echten
 *    SMTP-Empfänger, über den Mailserver der Instanz.
 * 3. **Und sie hinterlässt keine Zeile im Versandprotokoll.** Sie geht an der
 *    Warteschlange vorbei, weil `mail_log.tenant_id` `NOT NULL` ist und diese
 *    Mail keiner Organisation gehört (`SuperadminInvitationService`).
 * 4. **Der Einladungslink funktioniert.** Ohne das wäre der Rest eine Mail,
 *    die aussieht wie eine Einladung.
 * 5. ⚠️ **Und geht sie nicht hinaus, entsteht kein Konto.** Der verbotene
 *    Zustand: eine Adresse, die installationsweit belegt ist, zu einem Konto,
 *    das niemand einlösen kann.
 *
 * ## Eine eigene Datei
 *
 * `superadmins.spec.ts` misst die Ernennung und ihre Absagen und bringt
 * bewusst **keinen** Mailserver mit — dort ist „ohne Mailserver entsteht kein
 * Konto" der Fall. Diese Datei ist die andere Hälfte und braucht dafür einen
 * echten SMTP-Empfänger, eine Basis-Adresse und eine Installation ohne
 * Organisation.
 */

const SETUP_TIMEOUT_MS = 180_000;
const SUPERADMINS = apiPath('/admin/superadmins');

describe('eine Person in die Systemverwaltung einladen', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  let prisma: PrismaService;
  let inbox: SmtpInbox | undefined;

  let rootSession: string;

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

  function add(body: object): request.Test {
    return request(app().server)
      .post(SUPERADMINS)
      .set(authedMutation(rootSession))
      .send(body);
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
    prisma = testApp.prisma;
    inbox = await startSmtpInbox();

    /*
      **Keine Organisation.** Der Superadministrator, der einlädt, ist selbst
      in keiner — genau der Zustand einer frisch in Betrieb genommenen
      Installation, und der, in dem der Wunsch entsteht.
    */
    const root = await createUser(prisma, {
      email: 'root@einladung.invalid',
      password: 'test-password',
      isSuperadmin: true,
    });
    rootSession = await openSession(app(), root.id, null);

    await configureSystemMail(app(), {
      smtp: {
        host: '127.0.0.1',
        port: box().port,
        secure: false,
        auth: { user: 'installation', password: 'test-password-1!' },
        from: 'post@installation.invalid',
      },
      // Ohne sie ließe sich kein Einladungslink bilden — `plan` sagt das
      // vorher, und dann entstünde kein Konto.
      publicBaseUrl: 'https://formulare.invalid',
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await inbox?.close();
    await database?.release();
  });

  it('legt ein Konto ohne Mitgliedschaft an und lädt es ein', async () => {
    expect(
      await prisma.tenant.count(),
      'Der Aufbau ist „keine Organisation" — sonst misst der Fall etwas ' +
        'anderes.',
    ).toBe(0);
    const mark = box().messages.length;

    const created = await add({
      email: 'neue.person@einladung.invalid',
      name: 'Neue Person',
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      email: 'neue.person@einladung.invalid',
      name: 'Neue Person',
      hasMembership: false,
      invitationPending: true,
      invited: true,
    });

    // 1. Das Konto steht — mit der Systemverwaltung und ohne Passwort.
    const account = await prisma.user.findUniqueOrThrow({
      where: { email: 'neue.person@einladung.invalid' },
      select: {
        id: true,
        isSuperadmin: true,
        passwordHash: true,
        oidcSubject: true,
        memberships: { select: { id: true } },
      },
    });
    expect(account.isSuperadmin).toBe(true);
    expect(account.passwordHash).toBeNull();
    expect(account.oidcSubject).toBeNull();
    expect(account.memberships).toHaveLength(0);

    // 2. Die Mail ging wirklich hinaus, über den Block der Installation.
    const delivered = box().messages.slice(mark);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.to).toStrictEqual(['neue.person@einladung.invalid']);
    expect(delivered[0]?.from).toBe('post@installation.invalid');

    // 3. Und ohne Zeile im Versandprotokoll — die gehörte einer Organisation.
    expect(await prisma.mailLog.count()).toBe(0);

    /*
      4. **Der Link ist echt.** Die Einladungszeile steht, gehört diesem Konto
      und hängt an **keiner** `mail_log`-Zeile — das ist die Spur dieses Weges:
      derselbe Token wie sonst, nur ohne Warteschlange.
    */
    const invitation = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: account.id },
      select: { kind: true, mailLogId: true, usedAt: true },
    });
    expect(invitation.kind).toBe('invitation');
    expect(invitation.mailLogId).toBeNull();
    expect(invitation.usedAt).toBeNull();
  });

  it('ernennt ein vorhandenes Konto, statt ein zweites anzulegen', async () => {
    const existing = await createUser(prisma, {
      email: 'schon.da@einladung.invalid',
      password: 'test-password',
    });
    const mark = box().messages.length;

    const promoted = await add({
      email: 'schon.da@einladung.invalid',
      // Ein anderer Name als der gespeicherte: die Antwort muss den
      // **gespeicherten** nennen.
      name: 'Falsch Getippt',
    });

    expect(promoted.status).toBe(201);
    expect(promoted.body).toMatchObject({
      userId: existing.id,
      invited: false,
    });
    expect((promoted.body as { name: string }).name).not.toBe('Falsch Getippt');
    // Keine Einladung: das Konto hat sein Passwort schon.
    expect(box().messages.slice(mark)).toHaveLength(0);
    expect(
      await prisma.user.count({
        where: { email: 'schon.da@einladung.invalid' },
      }),
    ).toBe(1);
  });

  /**
   * ⚠️ **Der verbotene Zustand.** Geht die Einladung nicht hinaus, darf kein
   * Konto zurückbleiben: seine Adresse wäre installationsweit belegt, es
   * könnte sich nie anmelden, und auf diesem Weg gibt es keine Warteschlange,
   * die es später nachholte.
   *
   * Nachgestellt über einen Mailserver, der jede Anmeldung ablehnt — das ist
   * der Fehler, der im Betrieb wirklich vorkommt (ein falsches Passwort im
   * SMTP-Block).
   *
   * Steht am Ende, weil er den Empfänger umkonfiguriert.
   */
  it('nimmt das Konto zurück, wenn die Einladung nicht hinausgeht', async () => {
    box().refuseLogins(true);
    try {
      const refused = await add({
        email: 'geht.nicht@einladung.invalid',
        name: 'Geht Nicht',
      });

      expect(refused.status).toBe(422);
      expect((refused.body as { message: string }).message).toContain(
        'Einladung',
      );
      expect(
        await prisma.user.count({
          where: { email: 'geht.nicht@einladung.invalid' },
        }),
        'Ein Konto ohne zugestellte Einladung ist der Zustand, gegen den ' +
          'ADR-0024 die Reihenfolge festlegt — es darf nicht zurückbleiben.',
      ).toBe(0);
    } finally {
      box().refuseLogins(false);
    }
  });
});
