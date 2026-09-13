import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_OIDC_EMAIL_CLAIM,
  DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
  DEFAULT_OIDC_SCOPES,
} from '@formsache/shared';
import { startFakeIdp, type FakeIdp } from '@formsache/test-idp';

import {
  INVITATION_ACCOUNT_SHARED_MESSAGE,
  INVITATION_ALREADY_SET_UP_MESSAGE,
} from '../../src/tenant-admin/users.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  TEST_PUBLIC_BASE_URL,
  TEST_SYSTEM_SMTP_BLOCK,
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import {
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, openSession } from '../support/http';
import { resetRateLimit } from '../support/rate-limit';
import {
  TEST_REDIRECT_URI,
  configureOidc,
  outcomeOf,
  sessionSetCookie,
  signInThrough,
} from './oidc-flow';

/**
 * **Ein Issuer-Wechsel nimmt die offenen Einladungen mit** (Review-Runde 5
 * Nr. 3).
 *
 * ## Der Befund
 *
 * Eine SSO-Einladung ist eine `user`-Zeile, die mit dem Issuer der
 * **einladenden** Organisation gestempelt ist (`createOidcInvitation`), und der
 * erste Login löst sie ausschließlich gegen genau diesen Wert ein
 * (`auth/oidc/oidc-identity.service.ts`). Wechselte die Organisation danach
 * ihren Issuer, wurde **jede** offene Einladung unbrauchbar — still: die
 * eingeladene Person sah „abgelehnt", im Log stand „the invitation was stamped
 * with a different issuer", und „Einladung erneut senden" erneuerte nur den
 * Link, nicht den Stempel. Es gab keinen Weg zurück.
 *
 * ## Was hier gemessen wird — und was nicht
 *
 * Die *Form* der Anweisung (eine Transaktion, Lesen vor Schreiben, kein
 * Schreibvorgang bei unverändertem Issuer) steht als Einheitentest in
 * `src/tenancy/tenant-scope.spec.ts`, die Logzeile in
 * `src/tenant-admin/oidc-config.service.spec.ts`. Hier steht, was nur eine
 * echte Datenbank belegen kann: **welche Zeilen** der Wechsel erreicht, welche
 * er nicht erreicht, und dass die umgestempelte Einladung danach wirklich
 * eingelöst wird.
 *
 * ## Die entscheidende Anordnung: **eine geteilte Realm**
 *
 * ALPHA und BETA sind auf **denselben** alten Issuer konfiguriert — eine
 * Keycloak-Realm, ein Client je Organisation, die naheliegendste Betriebsform
 * (ADR-0012 Nr. 3a). Nur so belegt „BETAs Einladung bleibt unberührt"
 * etwas: fehlte die Mitgliedschaftsbedingung im `where`, träfe ALPHAs Speichern
 * BETAs Einladung mit, weil der Stempel identisch ist. Ein Aufbau mit zwei
 * Issuern wäre grün gegen genau diesen Fehler.
 *
 * ## Gegenproben, beim Schreiben gemessen
 *
 * - `memberships` aus dem `where` von `updateOidc` gestrichen → „lässt die
 *   Einladung der zweiten Organisation stehen" wird rot **und** BETAs Zeile
 *   trägt ALPHAs neuen Issuer;
 * - `none: { tenantId: { not } }` gestrichen → „lässt ein Konto stehen, das
 *   zwei Organisationen gehört" wird rot;
 * - `oidcSubject: null` gestrichen → „rührt ein gebundenes Konto nicht an"
 *   wird rot, und der Login der betroffenen Person geht danach an den falschen
 *   Provider;
 * - `restampInvitation` aus dem SSO-Zweig von `resendInvitation` entfernt →
 *   „erneuert den Stempel mit" wird rot, und der Login danach „abgelehnt".
 */

const SETUP_TIMEOUT_MS = 180_000;

/** Ein Client je Organisation, derselbe Wert bei beiden Providern. */
const CLIENT_ID = 'formsache';
const CLIENT_SECRET = 'ein-hinreichend-langes-client-secret';

const OIDC_PATH = '/tenant/oidc';
const USERS_PATH = '/tenant/users';

/** Die Adressen der Zeilen, die dieser Aufbau unterscheidet. */
const ALPHA_INVITED = 'eingeladen@alpha.invalid';
const SHARED_INVITED = 'geteilt@alpha.invalid';
const ALPHA_BOUND = 'gebunden@alpha.invalid';
const ALPHA_LOCAL = 'lokal@alpha.invalid';
const ALPHA_LOCAL_INVITED = 'lokal-eingeladen@alpha.invalid';
const ALPHA_SUPERADMIN = 'systemverwaltung@alpha.invalid';
const BETA_INVITED = 'eingeladen@beta.invalid';
const STALE_INVITED = 'veraltet@alpha.invalid';
/** Für die unnormalisierte Spalte — eingeladen von BETA, siehe unten. */
const SLASH_INVITED = 'schraegstrich@beta.invalid';

describe('ein Issuer-Wechsel und die offenen Einladungen', () => {
  let database: TestDatabase | undefined;
  let testApp: TestApp | undefined;
  /** Der Provider, mit dem beide Organisationen anfangen. */
  let oldIdp: FakeIdp | undefined;
  /** Der, auf den ALPHA wechselt. */
  let newIdp: FakeIdp | undefined;

  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaSession: string;
  let betaSession: string;

  function app(): TestApp {
    if (testApp === undefined) {
      throw new Error('the application was not started');
    }
    return testApp;
  }

  function oldProvider(): FakeIdp {
    if (oldIdp === undefined) {
      throw new Error('the old identity provider was not started');
    }
    return oldIdp;
  }

  function newProvider(): FakeIdp {
    if (newIdp === undefined) {
      throw new Error('the new identity provider was not started');
    }
    return newIdp;
  }

  /** Die beiden OIDC-Spalten einer Zeile, direkt aus PostgreSQL. */
  async function accountOf(email: string): Promise<{
    issuer: string | null;
    subject: string | null;
    hasPassword: boolean;
  }> {
    const row = await app().prisma.user.findUniqueOrThrow({
      where: { email },
      select: { oidcIssuer: true, oidcSubject: true, passwordHash: true },
    });
    return {
      issuer: row.oidcIssuer,
      subject: row.oidcSubject,
      hasPassword: row.passwordHash !== null,
    };
  }

  /** „Person hinzufügen" über die echte Route — die stempelt. */
  async function invite(
    session: string,
    tenant: TenantFixture,
    kind: 'local' | 'oidc',
    email: string,
  ): Promise<void> {
    const response = await request(app().server)
      .post(apiPath(USERS_PATH))
      .set(authedMutation(session))
      .send({
        kind,
        email,
        name: `Test ${email}`,
        groupId: tenant.adminGroupId,
      });
    expect(response.status).toBe(201);
  }

  /** Der Speichervorgang des Reiters *Erscheinungsbild & Login*. */
  function saveOidc(session: string, issuer: string): request.Test {
    return request(app().server)
      .put(apiPath(OIDC_PATH))
      .set(authedMutation(session))
      .send({
        enabled: true,
        issuer,
        clientId: CLIENT_ID,
        scopes: [...DEFAULT_OIDC_SCOPES],
        emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
        emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
        buttonLabel: null,
        clientSecret: CLIENT_SECRET,
      });
  }

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      // Eine Einladung entsteht nur, wenn die Installation eine verschicken
      // kann (ADR-0024) — Basis-Adresse **und** Mailserver.
      systemMail: {
        publicBaseUrl: TEST_PUBLIC_BASE_URL,
        smtp: TEST_SYSTEM_SMTP_BLOCK,
      },
      // Ein vertrauter Hop, damit die Anmeldeversuche aus verschiedenen
      // Adressen sprechen können — siehe `nextCaller` in `oidc-flow.ts`.
      env: { TRUST_PROXY_HOPS: 1 },
    });
    const prisma = app().prisma;

    oldIdp = await startFakeIdp(CLIENT_ID, CLIENT_SECRET, {
      redirectUri: TEST_REDIRECT_URI,
    });
    newIdp = await startFakeIdp(CLIENT_ID, CLIENT_SECRET, {
      redirectUri: TEST_REDIRECT_URI,
    });

    alpha = await createTenant(prisma, 'ISSA');
    beta = await createTenant(prisma, 'ISSB');
    // **Derselbe** Issuer bei beiden — siehe die geteilte Realm oben.
    await configureOidc(app(), alpha.id, oldProvider(), {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    await configureOidc(app(), beta.id, oldProvider(), {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    const alphaAdmin = await createUser(prisma, {
      email: 'verwaltung@alpha.invalid',
      password: 'ein hinreichend langes passwort',
      tenants: [alpha],
    });
    alphaSession = await openSession(app(), alphaAdmin.id, alpha.id);
    const betaAdmin = await createUser(prisma, {
      email: 'verwaltung@beta.invalid',
      password: 'ein hinreichend langes passwort',
      tenants: [beta],
    });
    betaSession = await openSession(app(), betaAdmin.id, beta.id);

    resetRateLimit(app());
    // Die offene Einladung, um die es geht — über die Route, damit der Stempel
    // der ist, den die Anwendung setzt, und nicht einer aus diesem Test.
    await invite(alphaSession, alpha, 'oidc', ALPHA_INVITED);
    // Eine zweite, deren Stempel nachher künstlich veraltet — der Zustand, für
    // den „erneut senden" der Weg zurück sein muss.
    await invite(alphaSession, alpha, 'oidc', STALE_INVITED);
    // Eine **lokale** Einladung: kein Passwort, kein Issuer. Sie darf hier
    // keinen bekommen — sonst würde aus einem Konto, das auf seinen
    // Passwort-Link wartet, ein SSO-Konto, das niemand eingeladen hat.
    await invite(alphaSession, alpha, 'local', ALPHA_LOCAL_INVITED);
    // Die Einladung der **zweiten** Organisation, auf demselben Issuer.
    await invite(betaSession, beta, 'oidc', BETA_INVITED);

    // Ein Konto, das zwei Organisationen gehört. Die Mitgliedschaft wird von
    // Hand geschrieben, weil die Route ein noch nicht eingelöstes Konto einer
    // anderen Organisation absichtlich nicht anhängt
    // (`EMAIL_INVITED_ELSEWHERE_MESSAGE`) — gemeint ist der Zustand, nicht der
    // Weg dorthin.
    await invite(alphaSession, alpha, 'oidc', SHARED_INVITED);
    const shared = await prisma.user.findUniqueOrThrow({
      where: { email: SHARED_INVITED },
      select: { id: true },
    });
    await prisma.membership.create({
      data: {
        tenantId: beta.id,
        userId: shared.id,
        groupId: beta.adminGroupId,
      },
    });

    // Ein **eingelöstes** SSO-Konto von ALPHA: Issuer und Subject gesetzt.
    const bound = await prisma.user.create({
      data: {
        email: ALPHA_BOUND,
        name: 'Gebundenes Konto',
        oidcIssuer: oldProvider().issuer,
        oidcSubject: randomUUID(),
      },
    });
    await prisma.membership.create({
      data: {
        tenantId: alpha.id,
        userId: bound.id,
        groupId: alpha.adminGroupId,
      },
    });

    // Ein lokales Konto **mit** Passwort.
    await createUser(prisma, {
      email: ALPHA_LOCAL,
      password: 'ein hinreichend langes passwort',
      tenants: [alpha],
    });

    // Eine offene SSO-Einladung, die inzwischen der Systemverwaltung gehört —
    // `SuperadminsService.promote` kann genau das aus ihr machen. Keine
    // Organisation entscheidet, welcher Provider ein Konto einlösen darf, das
    // die ganze Installation sehen kann.
    const superadmin = await prisma.user.create({
      data: {
        email: ALPHA_SUPERADMIN,
        name: 'Systemverwaltung',
        oidcIssuer: oldProvider().issuer,
        isSuperadmin: true,
      },
    });
    await prisma.membership.create({
      data: {
        tenantId: alpha.id,
        userId: superadmin.id,
        groupId: alpha.adminGroupId,
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await testApp?.close();
    await oldIdp?.close();
    await newIdp?.close();
    await database?.release();
  });

  beforeEach(() => {
    resetRateLimit(app());
  });

  describe('vor dem Wechsel', () => {
    it('stempelt die Einladung mit dem Issuer der einladenden Organisation', async () => {
      expect(await accountOf(ALPHA_INVITED)).toStrictEqual({
        issuer: oldProvider().issuer,
        subject: null,
        hasPassword: false,
      });
    });
  });

  describe('nach dem Wechsel', () => {
    beforeAll(async () => {
      resetRateLimit(app());
      const response = await saveOidc(alphaSession, newProvider().issuer);
      expect(response.status).toBe(200);
      // Der Wert in der Spalte ist der normalisierte des Schreibwegs; der
      // Stempel muss genau dieser sein, denn der Login vergleicht gegen ihn.
      expect((response.body as { issuer: string }).issuer).toBe(
        newProvider().issuer,
      );
    }, SETUP_TIMEOUT_MS);

    it('trägt in der offenen Einladung den neuen Issuer', async () => {
      expect(await accountOf(ALPHA_INVITED)).toStrictEqual({
        issuer: newProvider().issuer,
        subject: null,
        hasPassword: false,
      });
    });

    /**
     * **Der eigentliche Beleg.** Die eingeladene Person meldet sich beim
     * *neuen* Provider an und kommt herein — vor der Behebung endete dieser
     * Weg mit „abgelehnt" und der Warnung „stamped with a different issuer".
     */
    it('lässt die Einladung beim neuen Provider einlösen', async () => {
      const response = await signInThrough(app(), newProvider(), alpha.id, {
        sub: randomUUID(),
        email: ALPHA_INVITED,
      });

      expect(outcomeOf(response)).toBeNull();
      expect(sessionSetCookie(response)).toBeDefined();
      const account = await accountOf(ALPHA_INVITED);
      expect(account.issuer).toBe(newProvider().issuer);
      expect(account.subject).not.toBeNull();
    });

    /**
     * **Die Isolationsprobe, und sie muss scheitern können.** BETAs Einladung
     * steht auf demselben alten Issuer wie ALPHAs — ohne die
     * Mitgliedschaftsbedingung im `where` hätte ALPHAs Speichern sie
     * mitgenommen.
     */
    it('lässt die Einladung der zweiten Organisation stehen', async () => {
      expect(await accountOf(BETA_INVITED)).toStrictEqual({
        issuer: oldProvider().issuer,
        subject: null,
        hasPassword: false,
      });
    });

    /** Und sie ist dort weiterhin einlösbar — unberührt heißt: benutzbar. */
    it('lässt die zweite Organisation weiter anmelden', async () => {
      const response = await signInThrough(app(), oldProvider(), beta.id, {
        sub: randomUUID(),
        email: BETA_INVITED,
      });

      expect(outcomeOf(response)).toBeNull();
      expect(sessionSetCookie(response)).toBeDefined();
      expect((await accountOf(BETA_INVITED)).issuer).toBe(oldProvider().issuer);
    });

    /**
     * Ein Konto, das zwei Organisationen gehört: dieselbe Grenze, die „erneut
     * senden" als `belongsElsewhere` zieht. Eine Einladung, die auch einer
     * zweiten Organisation gehört, stempelt diese hier nicht um.
     */
    it('lässt ein Konto stehen, das zwei Organisationen gehört', async () => {
      expect(await accountOf(SHARED_INVITED)).toStrictEqual({
        issuer: oldProvider().issuer,
        subject: null,
        hasPassword: false,
      });
    });

    /**
     * Die Kehrseite davon, als unerlaubter Zugriff: der neue Provider von
     * ALPHA erreicht dieses Konto **nicht**, und die Einladung bleibt offen.
     */
    it('lässt das geteilte Konto vom neuen Provider nicht einlösen', async () => {
      const response = await signInThrough(app(), newProvider(), alpha.id, {
        sub: randomUUID(),
        email: SHARED_INVITED,
      });

      expect(outcomeOf(response)).toBe('abgelehnt');
      expect(sessionSetCookie(response)).toBeUndefined();
      expect(await accountOf(SHARED_INVITED)).toStrictEqual({
        issuer: oldProvider().issuer,
        subject: null,
        hasPassword: false,
      });
    });

    /**
     * Ein Konto, das sich schon einmal angemeldet hat, ist keine Einladung.
     * Es umzustempeln hieße, die Identität einer Person auf einen anderen
     * Provider umzuhängen — ADR-0012: der Schlüssel ist das Paar, und ein
     * gebundenes Paar wird hier nicht angefasst.
     */
    it('rührt ein gebundenes Konto nicht an', async () => {
      const account = await accountOf(ALPHA_BOUND);
      expect(account.issuer).toBe(oldProvider().issuer);
      expect(account.subject).not.toBeNull();
    });

    /**
     * Die beiden lokalen Zeilen. Was sie hier heraushält, sind zwei
     * Bedingungen: `password_hash IS NULL` für das fertige Konto — und
     * `oidc_issuer IS NOT NULL` für die offene *lokale* Einladung, die gar
     * keinen Stempel hat. Beides steht im `where`; ein Konto mit Passwort
     * **und** Issuer kann es nicht geben (CHECK `user_local_or_oidc`).
     */
    it('macht aus keinem lokalen Konto ein SSO-Konto', async () => {
      expect(await accountOf(ALPHA_LOCAL)).toStrictEqual({
        issuer: null,
        subject: null,
        hasPassword: true,
      });
      expect(await accountOf(ALPHA_LOCAL_INVITED)).toStrictEqual({
        issuer: null,
        subject: null,
        hasPassword: false,
      });
    });

    /** Und kein Konto der Systemverwaltung. */
    it('rührt die offene Einladung der Systemverwaltung nicht an', async () => {
      expect(await accountOf(ALPHA_SUPERADMIN)).toStrictEqual({
        issuer: oldProvider().issuer,
        subject: null,
        hasPassword: false,
      });
    });
  });

  describe('„Einladung erneut senden"', () => {
    /**
     * Der Zustand vor der Behebung, von Hand hergestellt: eine offene
     * Einladung, deren Stempel nicht mehr zur Konfiguration der Organisation
     * passt. Genau in diesem Zustand war „erneut senden" die einzige Handlung,
     * die einer Verwaltung noch blieb — und sie erneuerte nur den Link.
     */
    beforeAll(async () => {
      await app().prisma.user.update({
        where: { email: STALE_INVITED },
        data: { oidcIssuer: oldProvider().issuer },
      });
    });

    /** `POST /tenant/users/:id/invitation` für die Adresse einer Zeile. */
    async function resend(email: string): Promise<request.Response> {
      const account = await app().prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });
      return await request(app().server)
        .post(apiPath(`${USERS_PATH}/${account.id}/invitation`))
        .set(authedMutation(alphaSession))
        .send();
    }

    it('erneuert den Stempel mit — und der Login löst danach ein', async () => {
      // Der Ausgangszustand, damit der Fall nicht versehentlich grün ist.
      expect((await accountOf(STALE_INVITED)).issuer).toBe(
        oldProvider().issuer,
      );

      const resent = await resend(STALE_INVITED);
      expect(resent.status).toBe(204);

      // Der Stempel der Organisation, wie sie **jetzt** konfiguriert ist — und
      // nur dieser: nicht zusätzlich der alte, nicht der aus einer Anfrage.
      expect(await accountOf(STALE_INVITED)).toStrictEqual({
        issuer: newProvider().issuer,
        subject: null,
        hasPassword: false,
      });

      const response = await signInThrough(app(), newProvider(), alpha.id, {
        sub: randomUUID(),
        email: STALE_INVITED,
      });
      expect(outcomeOf(response)).toBeNull();
      expect(sessionSetCookie(response)).toBeDefined();
    });

    /**
     * **Der unerlaubte Fall, und er scheitert vor dem Schreiben.** Ein Konto,
     * das zwei Organisationen gehört, stempelt keine der beiden um — dieselbe
     * Grenze wie oben, hier über die Absage der Route
     * (`INVITATION_ACCOUNT_SHARED_MESSAGE`): die Handlung wirkt über die eigene
     * Organisation hinaus, also findet sie nicht statt.
     */
    it('stempelt nichts um, wenn das Konto zwei Organisationen gehört', async () => {
      const refused = await resend(SHARED_INVITED);

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        message: INVITATION_ACCOUNT_SHARED_MESSAGE,
      });
      expect(await accountOf(SHARED_INVITED)).toStrictEqual({
        issuer: oldProvider().issuer,
        subject: null,
        hasPassword: false,
      });
    });

    /**
     * Und ein Konto, das sich schon angemeldet hat, ist keine Einladung: die
     * Vorbedingung „noch nicht eingerichtet" bleibt unverändert, und ohne sie
     * hinge die Identität einer Person an einer Schaltfläche der Verwaltung.
     */
    it('stempelt ein bereits gebundenes SSO-Konto nicht um', async () => {
      const refused = await resend(ALPHA_BOUND);

      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        message: INVITATION_ALREADY_SET_UP_MESSAGE,
      });
      const account = await accountOf(ALPHA_BOUND);
      expect(account.issuer).toBe(oldProvider().issuer);
      expect(account.subject).not.toBeNull();
    });
  });

  /**
   * **Der zweite Weg, auf dem ein Stempel veraltet** (Review-Runde 5 Nr. 3,
   * Nachtrag).
   *
   * Der Login vergleicht nicht gegen die Spalte, sondern gegen
   * `acceptableIssuer(spalte)` (`OidcConfigService.signIn` → `token.issuer`);
   * gestempelt wurde die Spalte **roh**. Gleich waren beide nur, solange jeder
   * Schreiber der Spalte durch `checkedIssuer` gegangen ist — eine von Hand
   * reparierte Zeile oder eine aus einem älteren Stand („…/realms/hv/") führte
   * zu einem Stempel, den kein Login je trifft. Dasselbe Symptom wie oben,
   * dieselbe Logzeile, und mit dem Umstempeln allein nicht behoben: es hätte
   * denselben unbrauchbaren Wert erneuert.
   *
   * Hergestellt wird der Zustand hier so, wie er entsteht: die Spalte bekommt
   * den Schluss-Schrägstrich **direkt**, ohne den Schreibweg des Reiters. Der
   * Rest läuft über die echten Routen.
   *
   * ⚠️ Dieser Block läuft **zuletzt** und verstellt BETAs Konfiguration — die
   * Fälle oben brauchen sie in ihrem ursprünglichen Zustand.
   */
  describe('eine unnormalisierte Spalte', () => {
    beforeAll(async () => {
      resetRateLimit(app());
      await app().prisma.tenant.update({
        where: { id: beta.id },
        data: { oidcIssuer: `${oldProvider().issuer}/` },
      });
    });

    it('stempelt die normalisierte Fassung und lässt die Einladung einlösen', async () => {
      await invite(betaSession, beta, 'oidc', SLASH_INVITED);

      // **Nicht** der Wert aus der Spalte: der trägt einen Schrägstrich, den
      // die Anmeldung nie mitbringt.
      expect(await accountOf(SLASH_INVITED)).toStrictEqual({
        issuer: oldProvider().issuer,
        subject: null,
        hasPassword: false,
      });

      const response = await signInThrough(app(), oldProvider(), beta.id, {
        sub: randomUUID(),
        email: SLASH_INVITED,
      });
      expect(outcomeOf(response)).toBeNull();
      expect(sessionSetCookie(response)).toBeDefined();
    });
  });
});
