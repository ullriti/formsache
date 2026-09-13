import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_INVITATION_SEGMENT,
  LEGAL_ORG_SEGMENT,
  LICENCES_PATH,
  PASSWORD_RESET_SEGMENT,
  PUBLIC_FORM_SEGMENT,
  RESPONSE_DRAFT_SEGMENT,
  RESPONSE_EDIT_SEGMENT,
  SYSTEM_LEGAL_PAGES,
  TENANT_LEGAL_PAGES,
  systemLegalPath,
  tenantLegalPath,
} from '@formsache/shared';

import {
  DASHBOARD_PATH,
  MAIL_LOG_PATH,
  PROFILE_PATH,
  SYSTEM_AI_PATH,
  SYSTEM_LEGAL_SETTINGS_PATH,
  SYSTEM_MAIL_PATH,
  SYSTEM_MONITORING_PATH,
  SYSTEM_PATH,
  SYSTEM_SUPERADMINS_PATH,
  SYSTEM_TEMPLATES_PATH,
  TENANT_AI_PATH,
  TENANT_APPEARANCE_PATH,
  TENANT_FORM_DEFAULTS_PATH,
  TENANT_LEGAL_SETTINGS_PATH,
  TENANT_MAIL_PATH,
  TENANT_MEMBERS_PATH,
  TENANT_SETUP_PATH,
  TRASH_PATH,
  builderPath,
  formMembersPath,
  formSettingsPath,
  mailLogPath,
  notificationsPath,
  previewPath,
  responsesPath,
} from './routes';

/**
 * **Jedes Wort, das in einer Adresse vorkommt, steht hier untendrunter —
 * einzeln, ausgeschrieben, aufzuzählen** (ADR-0030, Nachtrag zu
 * Review-Runde 4 Nr. 8).
 *
 * ## Warum es diese Datei gibt
 *
 * Die Regel „Code ist englisch, und ein Pfadsegment ist Code" stand in
 * `AGENTS.md` und in `CONTRIBUTING.md` — als **Prosa**. Prosa lässt keinen Bau
 * scheitern. Herausgekommen ist genau das, was dabei herauskommt: über
 * Monate wuchsen `/verwaltung/ueberwachung`, `/formulare/<id>/benachrichtigungen`
 * und `/einladung/<token>` heran, jedes einzelne unauffällig, und erst als
 * jemand die Adresszeile las, fiel die Summe auf.
 *
 * Eine zweite Prosazeile hätte daran nichts geändert. Was hilft, ist eine
 * Stelle, an der ein **neues** Wort auffällt, bevor es ausgeliefert wird.
 *
 * ## Wie er wirkt — und was er ausdrücklich nicht kann
 *
 * Der Wächter entscheidet **nicht**, ob ein Wort englisch ist; das kann kein
 * Test. Er hält die **vollständige Menge** der Segmente fest. Wer eine Route
 * hinzufügt, deren Segment hier nicht steht, bekommt einen roten Fall mit dem
 * neuen Wort in der Meldung — und muss es hier eintragen. Genau dort liest es
 * dann ein Mensch, und zwar bevor die Adresse in einem Lesezeichen steht.
 *
 * Das ist derselbe Handel, den `templateDefects` für die Rechtstexte macht:
 * der Test weiß nichts über Inhalte, er sorgt nur dafür, dass nichts
 * unbemerkt dazukommt.
 *
 * ⚠️ **Diese Liste ist keine Erlaubnisliste des Routers.** Was `parseRoute`
 * annimmt, entscheidet `parseRoute`; hier steht, was die Anwendung
 * **schreibt**. Beide Seiten auseinanderlaufen zu lassen wäre möglich — dann
 * gäbe es eine Adresse, die niemand baut, und das fiele in `routes.test.ts`
 * auf, wo die Leseseite steht.
 */
const KNOWN_SEGMENTS: readonly string[] = [
  // Die drei Ausfüll-Adressen. Einbuchstabig, weil sie abgetippt und
  // vorgelesen werden — die Begründung steht an ihnen selbst.
  'a',
  'e',
  'f',
  // Das Segment einer Organisation vor ihren Rechtstexten.
  'o',
  // Die angemeldete Oberfläche.
  'admin',
  'ai',
  'appearance',
  'form-defaults',
  'forms',
  'legal',
  'mail',
  'mail-log',
  'members',
  'monitoring',
  'notifications',
  'preview',
  'profile',
  'responses',
  'settings',
  'setup',
  'superadmins',
  'system',
  'templates',
  'trash',
  // Die öffentlichen Seiten und die beiden eingelösten Links.
  'imprint',
  'invitation',
  'licences',
  'password',
  'privacy',
];

/** Ein Platzhalter, den die Sammlung unten für einen Wert einsetzt. */
const SAMPLE = 'PLATZHALTER';

/**
 * Jede Adresse, die diese Anwendung baut.
 *
 * Die Bauer werden **aufgerufen** und nicht abgeschrieben: eine Liste
 * getippter Adressen wäre die zweite Wahrheit, und sie ginge beim ersten neuen
 * Segment auseinander, ohne dass es jemand merkt — der Fehler, gegen den diese
 * Datei überhaupt steht.
 */
function everyAddress(): readonly string[] {
  return [
    DASHBOARD_PATH,
    PROFILE_PATH,
    MAIL_LOG_PATH,
    TRASH_PATH,
    TENANT_APPEARANCE_PATH,
    TENANT_FORM_DEFAULTS_PATH,
    TENANT_MEMBERS_PATH,
    TENANT_MAIL_PATH,
    TENANT_AI_PATH,
    TENANT_LEGAL_SETTINGS_PATH,
    TENANT_SETUP_PATH,
    SYSTEM_PATH,
    SYSTEM_MONITORING_PATH,
    SYSTEM_MAIL_PATH,
    SYSTEM_TEMPLATES_PATH,
    SYSTEM_AI_PATH,
    SYSTEM_LEGAL_SETTINGS_PATH,
    SYSTEM_SUPERADMINS_PATH,
    LICENCES_PATH,
    builderPath(SAMPLE),
    previewPath(SAMPLE),
    responsesPath(SAMPLE),
    formSettingsPath(SAMPLE),
    notificationsPath(SAMPLE),
    formMembersPath(SAMPLE),
    mailLogPath(SAMPLE),
    `/${PUBLIC_FORM_SEGMENT}/${SAMPLE}`,
    `/${RESPONSE_EDIT_SEGMENT}/${SAMPLE}`,
    `/${RESPONSE_DRAFT_SEGMENT}/${SAMPLE}`,
    `/${PASSWORD_RESET_SEGMENT}/${SAMPLE}`,
    `/${ACCOUNT_INVITATION_SEGMENT}/${SAMPLE}`,
    `/${LEGAL_ORG_SEGMENT}/${SAMPLE}`,
    ...SYSTEM_LEGAL_PAGES.map((page) => systemLegalPath(page)),
    ...TENANT_LEGAL_PAGES.map((page) => tenantLegalPath(SAMPLE, page)),
  ];
}

/** Die Segmente einer Adresse, ohne die eingesetzten Werte. */
function segmentsOf(address: string): readonly string[] {
  return address
    .split('/')
    .filter((segment) => segment !== '' && segment !== SAMPLE);
}

describe('die Adress-Segmente der Anwendung', () => {
  it('sind vollständig aufgezählt — ein neues fällt hier auf', () => {
    const used = new Set(everyAddress().flatMap(segmentsOf));

    expect(
      [...used].filter((segment) => !KNOWN_SEGMENTS.includes(segment)).sort(),
      'Dieses Segment ist neu. Trage es in KNOWN_SEGMENTS ein — und lies es ' +
        'dabei laut: Pfadsegmente sind Bezeichner und damit englisch ' +
        '(AGENTS.md, ADR-0030). Genau an dieser Stelle sind ' +
        '„ueberwachung", „benachrichtigungen" und „einladung" ' +
        'durchgerutscht, weil es sie nicht gab.',
    ).toStrictEqual([]);
  });

  /**
   * Die andere Richtung, und sie ist nicht bloß Ordnung: ein Segment, das hier
   * steht und nirgends mehr gebaut wird, ist eine Adresse, die es nicht mehr
   * gibt — und die Liste hörte auf, die Anwendung zu beschreiben. Genau so
   * wäre `barrierefreiheit` nach dem Streichen der Seite stehen geblieben.
   */
  it('enthalten kein Wort, das keine Adresse mehr baut', () => {
    const used = new Set(everyAddress().flatMap(segmentsOf));

    expect(
      KNOWN_SEGMENTS.filter((segment) => !used.has(segment)),
      'Dieses Segment steht in KNOWN_SEGMENTS, aber keine Adresse baut es ' +
        'mehr. Streichen — sonst beschreibt die Liste eine Anwendung, die es ' +
        'nicht mehr gibt.',
    ).toStrictEqual([]);
  });

  /**
   * Der Formcheck daneben, weil er billig ist: Kleinbuchstaben, Ziffern und
   * der Bindestrich. Er fängt keinen deutschen Begriff, aber er fängt das
   * Umlaut-Ersatzwort (`ueberwachung` wäre durchgekommen, `überwachung` nicht)
   * und jede Adresse, die eine Kodierung nötig machte.
   */
  it('sind kleingeschrieben und ohne Sonderzeichen', () => {
    expect(
      KNOWN_SEGMENTS.filter((segment) => !/^[a-z0-9-]+$/u.test(segment)),
    ).toStrictEqual([]);
  });
});
