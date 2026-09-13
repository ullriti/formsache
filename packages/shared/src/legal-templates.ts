import type { LegalSlot, LegalTemplate } from './legal.ts';
import type { SystemLegalPage, TenantLegalPage } from './legal.ts';

/**
 * **The shipped templates** — the wording from `docs/legal/vorlagen/`, here,
 * because it is needed here.
 *
 * ## Why the text stands in the code and does not stay in the directory
 *
 * Because a template that only lies in the repository does not exist for the
 * operator of an installation. They have no `docs/`, they have a settings page
 * — and the work item explicitly says that the texts are *available to them*,
 * not that they are filed away somewhere. What lies here is therefore no copy
 * for convenience but the **shipping**: `docs/legal/vorlagen/` is the
 * lawyer-drafted version with its reasons and warnings to the person filling
 * it in, this is the publishable body of it.
 *
 * ## What deliberately became different on the way here
 *
 * 1. **The note blocks addressed to the person filling in are gone.** In the
 *    template they stand as quote blocks („⚠️ Die E-Mail-Adresse ist Pflicht
 *    …"); here they are {@link LegalSlot.hint} at the corresponding field. They
 *    belong next to the input field, not in the published text — there they
 *    would be an instruction to the reader that is none of their business.
 * 2. **The placeholders are normalised.** In the template they partly stand
 *    with an explanation in the name (`[[GESETZESGRUNDLAGE — z. B. …]]`) and
 *    partly twice with different meanings (`[[ORT]]` once for the operator's
 *    seat, once for that of the data centre). A placeholder here is a
 *    **field**, and two fields need two names; the explanation has become the
 *    `hint`.
 * 3. **`⟪NUR WENN …⟫` is called `⟪WENN:schluessel⟫`.** A sentence a human
 *    judges becomes a switch the interface offers — otherwise the marking
 *    would stay standing in the text, and that is exactly what the template
 *    forbids.
 * 4. **What the application knows, nobody types.** Addresses of its own legal
 *    text pages, the name of the organisation and that of the operator are
 *    `APP_` placeholders (see `legal.ts`).
 *
 * ⚠️ **Whoever changes the software checks these texts along with it.** They
 * assert facts about the behaviour of the application — no cookies, no
 * third-party content, 30 days draft retention, 90 days mail log. The checked
 * basis stands in `docs/legal/README.md`, section 6.
 */

// ---------------------------------------------------------------------------
// Recurring fields
// ---------------------------------------------------------------------------

/**
 * **Die Telefonnummer, einmal geschrieben** — sie steht in vier der fünf
 * Vorlagen und dort mit demselben Wortlaut (Befund des Reviews zu Review-Runde
 * 5).
 *
 * Anders als bei der E-Mail-Adresse, die je Seite etwas anderes erklärt, ist
 * das echte Kopie: derselbe Hinweis, dasselbe Beispiel, dieselbe
 * Freiwilligkeit. Vier Kopien wären vier Orte, an denen der nächste Satz zur
 * Rechtslage nachgezogen werden müsste — und der vergessene ist der, der falsch
 * wird.
 *
 * `group` ist das Einzige, was sich unterscheidet: in welchem Abschnitt des
 * Formulars das Feld steht, weiß die Seite und nicht das Feld.
 */
function phoneSlot(group?: string): LegalSlot {
  return {
    key: 'TELEFONNUMMER',
    label: 'Telefonnummer',
    hint: 'Nicht zwingend, wenn ein zweiter schneller Kommunikationsweg besteht (§ 5 Abs. 1 Nr. 2 DDG, EuGH C-298/07) — aber der unstreitige Weg.',
    example: '+49 30 123456-0',
    ...(group === undefined ? {} : { group }),
    optional: true,
  };
}

/**
 * The address fields that are named alike in four templates.
 *
 * Der Abschnitt kommt als Parameter herein: dieselben drei Felder gehören im
 * Impressum unter *Anbieter*, in der Datenschutzerklärung unter
 * *Verantwortliche Stelle*. Eine feste Überschrift hier wäre in einer der
 * beiden Vorlagen die falsche.
 */
function addressSlots(group?: string): readonly LegalSlot[] {
  const of = (slot: LegalSlot): LegalSlot =>
    group === undefined ? slot : { ...slot, group };
  return [
    of({
      key: 'STRASSE_UND_HAUSNUMMER',
      label: 'Straße und Hausnummer',
      example: 'Musterstraße 1',
    }),
    of({ key: 'PLZ', label: 'Postleitzahl', example: '12345' }),
    of({ key: 'ORT', label: 'Ort', example: 'Musterstadt' }),
  ];
}

// ---------------------------------------------------------------------------
// Template 01 — imprint of the operator
// ---------------------------------------------------------------------------

const SYSTEM_IMPRINT: LegalTemplate = {
  key: 'system:imprint',
  title: 'Impressum',
  purpose:
    'Die Anbieterkennzeichnung dieser Installation nach § 5 DDG und § 18 Abs. 1 MStV. Sie ist aus der Fußzeile jeder Seite verlinkt — auch der öffentlichen Ausfüllseiten.',
  body: `Angaben gemäß § 5 DDG und § 18 Abs. 1 MStV.

### Anbieter dieses Angebots

[[NAME_DES_BETREIBERS]]
⟪WENN:juristische-person⟫[[RECHTSFORM]]⟪ENDE⟫
[[STRASSE_UND_HAUSNUMMER]]
[[PLZ]] [[ORT]]
[[LAND]]

⟪WENN:juristische-person⟫
**Vertreten durch:** [[VERTRETUNGSBERECHTIGTE]]
⟪ENDE⟫

### Kontakt

Telefon: [[TELEFONNUMMER]]
E-Mail: [[E_MAIL_ADRESSE]]

⟪WENN:registereintrag⟫
### Registereintrag

Registergericht: [[REGISTERGERICHT]]
Registerart: [[REGISTERART]]
Registernummer: [[REGISTERNUMMER]]
⟪ENDE⟫

⟪WENN:umsatzsteuer⟫
### Umsatzsteuer-Identifikationsnummer

Umsatzsteuer-Identifikationsnummer gemäß § 27 a Umsatzsteuergesetz: [[UST_IDNR]]
⟪ENDE⟫

⟪WENN:reglementierter-beruf⟫
### Aufsichtsbehörde und berufsrechtliche Angaben

Zuständige Aufsichtsbehörde: [[AUFSICHTSBEHOERDE]]
Gesetzliche Berufsbezeichnung: [[BERUFSBEZEICHNUNG]] (verliehen in: [[VERLEIHUNGSSTAAT]])
Maßgebliche berufsrechtliche Regelungen: [[BERUFSREGELUNGEN]], einsehbar unter [[ADRESSE_DER_BERUFSREGELUNGEN]]
⟪ENDE⟫

⟪WENN:oeffentliche-stelle⟫
### Zuständige Rechtsaufsicht

[[RECHTSAUFSICHT]]
⟪ENDE⟫

⟪WENN:journalistisch-redaktionell⟫
### Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV

[[MSTV_VERANTWORTLICH]]
⟪ENDE⟫

### Was dieses Angebot ist — und was nicht

Unter dieser Adresse wird eine Installation der Software **Formsache** betrieben. Formsache ist eine quelloffene Formular- und Umfrageplattform; die Software wird von [[NAME_DES_BETREIBERS]] **eingesetzt**, nicht angeboten oder vertrieben. Angaben zur Software, ihrer Herkunft und ihrer Lizenz stehen unter [Lizenzen und Urheberrecht]([[APP_ADRESSE_LIZENZEN]]).

Über diese Installation stellen **mehrere eigenständige Organisationen** Formulare bereit. Für den **Inhalt** eines Formulars, für die darüber erhobenen Daten und für die Zwecke der Erhebung ist die jeweilige Organisation verantwortlich — nicht [[NAME_DES_BETREIBERS]]. Wer für ein bestimmtes Formular verantwortlich ist, steht in der Fußzeile der jeweiligen Formularseite unter „Verantwortlich für dieses Formular".

### Datenschutz

Wie [[NAME_DES_BETREIBERS]] mit personenbezogenen Daten umgeht, steht in der [Datenschutzerklärung]([[APP_ADRESSE_DATENSCHUTZ]]).

⟪WENN:verbraucherstreitbeilegung⟫
### Verbraucherstreitbeilegung

Die Europäische Kommission stellt eine Plattform zur Online-Streitbeilegung bereit: [[ADRESSE_DER_OS_PLATTFORM]].

[[NAME_DES_BETREIBERS]] ist zur Teilnahme an einem Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle [[BEREITSCHAFT_ZUR_SCHLICHTUNG]].
⟪ENDE⟫`,
  fixed: null,
  emptyBody: `**Für dieses Angebot sind bislang keine Anbieterangaben hinterlegt.**

Unter dieser Adresse wird eine Installation der quelloffenen Formular- und Umfrageplattform **Formsache** betrieben. Wer sie betreibt, ist an dieser Stelle nicht hinterlegt; die Angaben nach § 5 DDG und § 18 Abs. 1 MStV fehlen also.

Für den **Inhalt** eines Formulars und für die darüber erhobenen Daten ist stets die Organisation verantwortlich, die es anbietet — nicht der Betrieb dieser Plattform. Wer das ist, steht in der Fußzeile der jeweiligen Formularseite unter „Verantwortlich für dieses Formular", und dort finden Sie auch deren Anbieterangaben.

Angaben zur Software, ihrer Herkunft und ihrer Lizenz stehen unter [Lizenzen und Urheberrecht]([[APP_ADRESSE_LIZENZEN]]).`,
  slots: [
    {
      key: 'NAME_DES_BETREIBERS',
      label: 'Name des Betreibers',
      hint: 'Der Name, unter dem diese Installation betrieben wird. Er erscheint auch in der Fußzeile jeder öffentlichen Seite unter „Betrieb dieser Plattform".',
      example: 'Musterverein e. V.',
      group: 'Anbieter dieses Angebots',
    },
    {
      key: 'RECHTSFORM',
      label: 'Rechtsform',
      hint: 'Nur bei juristischen Personen und Personengesellschaften, z. B. „e. V.", „gGmbH", „Körperschaft des öffentlichen Rechts".',
      example: 'eingetragener Verein',
      group: 'Anbieter dieses Angebots',
    },
    ...addressSlots('Anbieter dieses Angebots'),
    {
      key: 'LAND',
      label: 'Land',
      example: 'Deutschland',
      group: 'Anbieter dieses Angebots',
    },
    {
      key: 'VERTRETUNGSBERECHTIGTE',
      label: 'Vertretungsberechtigte Person(en)',
      hint: '§ 18 Abs. 1 MStV verlangt bei juristischen Personen die Angabe des Vertretungsberechtigten.',
      example: 'Erika Mustermann (Vorsitzende), Max Mustermann (Schatzmeister)',
      group: 'Anbieter dieses Angebots',
    },
    phoneSlot('Kontakt'),
    {
      key: 'E_MAIL_ADRESSE',
      label: 'E-Mail-Adresse',
      hint: 'Pflicht nach § 5 Abs. 1 Nr. 2 DDG und muss unmittelbare Kommunikation erlauben. Ein reines Kontaktformular genügt nach der Rechtsprechung nicht.',
      example: 'info@musterverein.example',
      group: 'Kontakt',
    },
    {
      key: 'REGISTERGERICHT',
      label: 'Registergericht',
      example: 'Amtsgericht Musterstadt',
      group: 'Registereintrag',
    },
    {
      key: 'REGISTERART',
      label: 'Registerart',
      hint: 'Vereinsregister, Handelsregister oder Genossenschaftsregister.',
      example: 'Vereinsregister',
      group: 'Registereintrag',
    },
    {
      key: 'REGISTERNUMMER',
      label: 'Registernummer',
      example: 'VR 12345',
      group: 'Registereintrag',
    },
    {
      key: 'UST_IDNR',
      label: 'Umsatzsteuer-Identifikationsnummer',
      hint: 'Nur, wenn eine vorhanden ist. Die Steuernummer gehört ausdrücklich nicht hierher.',
      example: 'DE123456789',
      group: 'Umsatzsteuer',
    },
    {
      key: 'AUFSICHTSBEHOERDE',
      label: 'Aufsichtsbehörde (Name und Anschrift)',
      hint: 'Nur bei einem reglementierten Beruf — die Kammer oder Behörde, die ihn beaufsichtigt. Nicht die Datenschutzaufsicht; die steht in der Datenschutzerklärung.',
      example:
        'Rechtsanwaltskammer Musterstadt, Musterstraße 1, 12345 Musterstadt',
      multiline: true,
      group: 'Reglementierter Beruf',
    },
    {
      key: 'BERUFSBEZEICHNUNG',
      label: 'Gesetzliche Berufsbezeichnung',
      example: 'Rechtsanwältin',
      group: 'Reglementierter Beruf',
    },
    {
      key: 'VERLEIHUNGSSTAAT',
      label: 'Staat der Verleihung',
      example: 'Bundesrepublik Deutschland',
      group: 'Reglementierter Beruf',
    },
    {
      key: 'BERUFSREGELUNGEN',
      label: 'Berufsrechtliche Regelungen',
      hint: 'Bezeichnung der maßgeblichen Regelungen.',
      example:
        'Bundesrechtsanwaltsordnung (BRAO), Berufsordnung für Rechtsanwälte (BORA)',
      group: 'Reglementierter Beruf',
    },
    {
      key: 'ADRESSE_DER_BERUFSREGELUNGEN',
      label: 'Adresse der Berufsregelungen',
      hint: 'Eine http- oder https-Adresse, unter der die Regelungen einsehbar sind.',
      example: 'https://www.brak.de/fuer-anwaelte/berufsrecht/',
      group: 'Reglementierter Beruf',
    },
    {
      key: 'RECHTSAUFSICHT',
      label: 'Rechtsaufsicht (Name und Anschrift)',
      hint: 'Nur bei öffentlichen Stellen — wer die Rechtsaufsicht führt.',
      example:
        'Regierungspräsidium Musterstadt, Musterstraße 1, 12345 Musterstadt',
      multiline: true,
      group: 'Öffentliche Stelle',
    },
    {
      key: 'MSTV_VERANTWORTLICH',
      label: 'Verantwortlich nach § 18 Abs. 2 MStV (Name und Anschrift)',
      hint: 'Nur, wenn tatsächlich journalistisch-redaktionell gestaltete Angebote bereitgehalten werden. Ein Formularsystem allein ist das nicht.',
      example: 'Erika Mustermann, Musterstraße 1, 12345 Musterstadt',
      multiline: true,
      group: 'Journalistisch-redaktionelle Angebote',
    },
    {
      key: 'ADRESSE_DER_OS_PLATTFORM',
      label: 'Adresse der EU-Plattform zur Online-Streitbeilegung',
      suggestion: 'https://ec.europa.eu/consumers/odr/',
      group: 'Verbraucherstreitbeilegung',
    },
    {
      key: 'BEREITSCHAFT_ZUR_SCHLICHTUNG',
      label: 'Bereitschaft zur Schlichtung',
      hint: 'Entweder „nicht bereit" oder „bereit" nebst Name und Anschrift der Verbraucherschlichtungsstelle.',
      suggestion:
        'weder bereit noch verpflichtet, an einem Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen',
      multiline: true,
      group: 'Verbraucherstreitbeilegung',
    },
  ],
  conditions: [
    {
      key: 'juristische-person',
      label:
        'Der Betreiber ist eine juristische Person oder Personengesellschaft',
      hint: 'Blendet Rechtsform und Vertretungsberechtigte ein — bei einer natürlichen Person entfallen beide.',
    },
    {
      key: 'registereintrag',
      label: 'Der Betreiber ist in ein Register eingetragen',
    },
    {
      key: 'umsatzsteuer',
      label: 'Es gibt eine Umsatzsteuer-Identifikationsnummer',
    },
    {
      key: 'reglementierter-beruf',
      label: 'Reglementierter Beruf oder zulassungspflichtige Tätigkeit',
    },
    {
      key: 'oeffentliche-stelle',
      label: 'Der Betreiber ist eine öffentliche Stelle',
    },
    {
      key: 'journalistisch-redaktionell',
      label: 'Es werden journalistisch-redaktionelle Inhalte angeboten',
      hint: 'Ein Formularsystem allein ist das nicht. Eine überflüssige Angabe behauptet etwas über das Angebot, das nicht stimmt.',
    },
    {
      key: 'verbraucherstreitbeilegung',
      label: 'Es finden Verbrauchergeschäfte statt',
      hint: 'Der Regelfall bei dieser Software ist: nein. Dann entfällt der Block ersatzlos.',
    },
  ],
};

// ---------------------------------------------------------------------------
// Template 03 — privacy policy of the operator
// ---------------------------------------------------------------------------

const SYSTEM_PRIVACY: LegalTemplate = {
  key: 'system:privacy',
  title: 'Datenschutzerklärung',
  purpose:
    'Die Verarbeitungen, bei denen der Betrieb dieser Installation selbst Verantwortlicher ist: Auslieferung, Betriebssicherheit, Sicherungen, Konten der Bearbeitenden, Mailversand, KI-Funktion. Die Inhalte der Formulare deckt sie ausdrücklich nicht ab — dafür ist jede Organisation selbst verantwortlich.',
  body: `**Stand:** [[STAND]]

### 1. Wer für diese Anwendung verantwortlich ist

Verantwortlich im Sinne der Datenschutz-Grundverordnung für den **Betrieb** dieser Anwendung ist:

[[NAME_DES_BETREIBERS]]
[[STRASSE_UND_HAUSNUMMER]]
[[PLZ]] [[ORT]]
E-Mail: [[E_MAIL_FUER_DATENSCHUTZANFRAGEN]]
Telefon: [[TELEFONNUMMER]]

⟪WENN:datenschutzbeauftragter⟫
**Datenschutzbeauftragte Person:** [[DATENSCHUTZBEAUFTRAGTER]]
⟪ENDE⟫
⟪WENN:kein-datenschutzbeauftragter⟫
Eine Datenschutzbeauftragte oder ein Datenschutzbeauftragter ist **nicht bestellt**; die gesetzlichen Voraussetzungen dafür liegen nicht vor.
⟪ENDE⟫

### 2. Was diese Anwendung ist — und wer wofür verantwortlich ist

Unter dieser Adresse wird eine Formular- und Umfrageplattform betrieben. Über sie stellen **mehrere eigenständige Organisationen** eigene Formulare bereit.

| Worum es geht | Wer ist verantwortlich | Wo steht die Information |
|---|---|---|
| Die **Inhalte** eines Formulars: welche Fragen gestellt werden, wofür die Antworten verwendet werden, wie lange sie aufbewahrt werden | die Organisation, die das Formular anbietet | in den Datenschutzhinweisen dieser Organisation, verlinkt in der Fußzeile des Formulars |
| Der **technische Betrieb**: Auslieferung der Seiten, Schutz vor Überlastung und Missbrauch, Datensicherung, Überwachung | [[NAME_DES_BETREIBERS]] | in dieser Erklärung |
| Die **Konten der Bearbeitenden** | [[NAME_DES_BETREIBERS]] und die jeweilige Organisation gemeinsam | Abschnitt 5 |

Für die Antworten, die Sie in ein Formular eintragen, verarbeitet [[NAME_DES_BETREIBERS]] **im Auftrag** der jeweiligen Organisation (Art. 28 DSGVO) — nicht für eigene Zwecke. Mit jeder Organisation besteht dazu ein Auftragsverarbeitungsvertrag.

### 3. Was beim bloßen Aufrufen einer Seite geschieht

**Diese Anwendung setzt beim Ausfüllen eines Formulars keine Cookies, speichert nichts in Ihrem Browser und lädt keine Inhalte von Dritten.**

- **Keine Cookies auf den öffentlichen Seiten.** Ein Cookie wird ausschließlich gesetzt, wenn sich eine Person an dieser Anwendung **anmeldet** — siehe Abschnitt 5.
- **Keine Speicherung in Ihrem Browser.** Weder lokaler noch Sitzungsspeicher werden verwendet. Auch das Kennwort eines kennwortgeschützten Formulars wird nach der Eingabe **nicht** im Browser abgelegt.
- **Keine Inhalte von Dritten.** Schriftarten, Bilder, Skripte und Formatvorlagen werden ausschließlich von diesem Server ausgeliefert. Es gibt kein Schriften-Netzwerk, keine Karten, keine eingebetteten Videos, keine Schaltflächen sozialer Netzwerke.
- **Keine Reichweitenmessung, keine Analyse, kein Tracking, kein Profiling und keine automatisierte Entscheidungsfindung** im Sinne des Art. 22 DSGVO.

Weil damit weder Informationen in Ihrer Endeinrichtung gespeichert noch aus ihr ausgelesen werden, **braucht diese Anwendung keine Einwilligung nach § 25 TDDDG** und zeigt deshalb auch keinen Cookie-Hinweis.

### 3.1 Ihre IP-Adresse

Damit Ihr Browser eine Antwort erhält, muss der Server Ihre IP-Adresse verarbeiten. Darüber hinaus wird sie ausschließlich verwendet, um die Anwendung gegen Überlastung und automatisierten Missbrauch zu schützen.

- Die Adresse wird dafür **nur im Arbeitsspeicher** gehalten, nicht in der Datenbank gespeichert.
- Sie wird nach Ablauf des jeweiligen Zeitfensters verworfen: **längstens zwei Minuten** bei Formularaufrufen, Absendungen und Kennworteingaben, **längstens eine Stunde** bei Datei-Uploads.
- Bei IPv6 wird nur der Netzanteil verwendet, nicht die vollständige Adresse.
- **Die Protokolldateien der Anwendung enthalten keine IP-Adressen** und keine Formularinhalte.

**Rechtsgrundlage:** Art. 6 Abs. 1 lit. f DSGVO. Berechtigtes Interesse ist der sichere und verfügbare Betrieb der Anwendung.

Vor dieser Anwendung steht ein Zugangsserver, der die Verschlüsselung übernimmt. Ob und wie lange er Zugriffe protokolliert, entscheidet [[NAME_DES_BETREIBERS]]: [[AUSSAGE_ZUM_ZUGANGSSERVER]]

### 4. Was beim Ausfüllen eines Formulars geschieht

Die **Inhalte** Ihrer Antworten verarbeitet [[NAME_DES_BETREIBERS]] nur im Auftrag der Organisation, die das Formular anbietet. Über Zweck, Rechtsgrundlage und Aufbewahrung entscheidet **sie**; ihre Datenschutzhinweise sind in der Fußzeile des Formulars verlinkt.

Was [[NAME_DES_BETREIBERS]] beisteuert, ist die technische Ausführung. Wie sie im Einzelnen aussieht — welche Daten wo liegen, wer sie sehen kann und nach welchen Fristen sie gelöscht werden — steht in Teil B der Datenschutzhinweise jeder Organisation und gilt für alle Organisationen dieser Installation gleichermaßen.

### 5. Konten der Bearbeitenden

Dieser Abschnitt betrifft **nur** Personen mit einem Zugang zu dieser Anwendung. Wer lediglich ein Formular ausfüllt, hat kein Konto und ist hiervon nicht betroffen.

**Gemeinsame Verantwortlichkeit (Art. 26 DSGVO).** [[NAME_DES_BETREIBERS]] und die jeweilige Organisation entscheiden hier gemeinsam: die Organisation darüber, wen sie einlädt und welche Rechte sie vergibt; [[NAME_DES_BETREIBERS]] über das Anmeldeverfahren, die Sitzungsdauer und den Versand der Kontomails. Das Wesentliche der dazu geschlossenen Vereinbarung: [[VEREINBARUNG_ART_26]] Ihre Rechte nach der DSGVO können Sie gegenüber **jedem** der beiden geltend machen (Art. 26 Abs. 3); zentrale Anlaufstelle ist [[ANLAUFSTELLE]].

| Was | Wozu | Wie lange |
|---|---|---|
| Name, E-Mail-Adresse | Anmeldung, Zuordnung von Bearbeitungen, Kontomails | mit dem Konto |
| Kennwort als Argon2id-Prüfwert oder die Kennung eines externen Anmeldedienstes | Anmeldung | mit dem Konto |
| Gruppen- und Formularrechte, Zeitpunkt der letzten Anmeldung | Rechteprüfung | mit dem Konto |
| Sitzungen | angemeldet bleiben | abgelaufene oder abgemeldete Sitzungen werden nach **7 Tagen** physisch gelöscht |
| Links zum Zurücksetzen des Kennworts und Einladungslinks | Erstzugang, Kennwortwechsel | nach Ablauf oder Einlösung **7 Tage**, dann physisch gelöscht |

**Zwei Cookies**, beide für den angemeldeten Betrieb unbedingt erforderlich und deshalb ohne Einwilligung zulässig (§ 25 Abs. 2 Nr. 2 TDDDG): ein Sitzungs-Cookie, das die Anmeldung hält, und ein CSRF-Token-Cookie, das vor Anfragen schützt, die eine fremde Seite in Ihrem Namen stellt. Beide enden mit der Sitzung, längstens nach [[SITZUNGSDAUER]] Stunden.

Ein Konto wird **nicht** durch Selbstregistrierung angelegt, sondern nur durch eine Einladung. Die Einladungsmail geht über den Mailserver von [[NAME_DES_BETREIBERS]] hinaus; ihr Wortlaut ist fest und von keiner Organisation änderbar.

⟪WENN:sso⟫
**Anmeldung über einen externen Anmeldedienst.** Nutzt eine Organisation ihren eigenen Identitätsanbieter, erfährt dieser, dass und wann eine Anmeldung stattgefunden hat. Welche Daten er dabei verarbeitet, bestimmt die Organisation und nicht [[NAME_DES_BETREIBERS]].
⟪ENDE⟫

**Rechtsgrundlage:** Art. 6 Abs. 1 lit. b DSGVO (Durchführung des Nutzungsverhältnisses) bzw. Art. 6 Abs. 1 lit. e DSGVO bei öffentlichen Stellen: [[RECHTSGRUNDLAGE_KONTEN]]

### 6. E-Mail-Versand

Diese Anwendung versendet E-Mails: Bestätigungen an Ausfüllende, Benachrichtigungen an Bearbeitende, Kontomails, Betriebsalarme.

- Der Versand läuft über [[MAILSERVER_ODER_DIENSTLEISTER]]. Organisationen können einen **eigenen** Mailserver eintragen; tun sie das, läuft ihr Versand über diesen, und die Verantwortung dafür liegt bei ihnen.
- Zum Nachweis der Zustellung führt die Anwendung ein **Versandprotokoll**: Empfängeradresse, Betreff, der gerenderte Text der Nachricht, Status und Versuchszeitpunkte. **Der Text kann Formularinhalte enthalten** — deshalb wird jede Protokollzeile nach **90 Tagen** physisch gelöscht. Wird eine Antwort endgültig gelöscht, werden die personenbezogenen Spalten der zugehörigen Protokollzeilen sofort geleert.
- **Anlagen zu Antworten werden nicht per E-Mail versendet.**

Eine bereits versendete E-Mail liegt im Postfach ihres Empfängers und lässt sich durch eine Löschung in dieser Anwendung nicht zurückholen.

### 7. Datensicherung

Datenbank und Dateiablage werden regelmäßig gesichert; die Sicherungen sind verschlüsselt und werden [[AUFBEWAHRUNG_SICHERUNGEN]] Tage aufbewahrt, danach gelöscht. Aufbewahrungsort: [[ORT_DER_SICHERUNGEN]].

Wird ein Datensatz in dieser Anwendung endgültig gelöscht, verschwindet er aus dem laufenden Betrieb. In bereits erstellten Sicherungen bleibt er bis zum Ablauf der Aufbewahrungsfrist enthalten. Wird eine Sicherung eingespielt, wird die Löschung an dem wiederhergestellten Bestand erneut vorgenommen.

**Rechtsgrundlage:** Art. 6 Abs. 1 lit. f in Verbindung mit Art. 32 Abs. 1 lit. c DSGVO.

### 8. Betriebsüberwachung

Die Anwendung führt über ihre Hintergrundläufe Buch — je Lauf eine Zeile mit Zeitpunkt, Ergebnis und Anzahl. **Diese Zeilen benennen keine Personen.** Bleiben Läufe aus oder häufen sich Fehler, geht ein Alarm an [[ALARM_ADRESSE]].

### 9. Empfänger und Auftragsverarbeiter

| Empfänger | Wofür | Ort |
|---|---|---|
| [[NAME_DES_HOSTERS]] | Bereitstellung der Server | [[ORT_DES_RECHENZENTRUMS]] |
| [[NAME_DES_MAILDIENSTLEISTERS]] | Versand der E-Mails | [[ORT_DES_MAILDIENSTLEISTERS]] |

⟪WENN:weitere-dienstleister⟫
Weitere Auftragsverarbeiter: [[WEITERE_DIENSTLEISTER]]
⟪ENDE⟫

Mit allen genannten Stellen bestehen Verträge zur Auftragsverarbeitung nach Art. 28 DSGVO.

**Eine Übermittlung an Behörden** erfolgt nur, soweit eine gesetzliche Verpflichtung besteht. Eine Weitergabe zu Werbezwecken oder ein Verkauf von Daten findet nicht statt.

**Zwischen den Organisationen dieser Installation werden keine Daten ausgetauscht.** Die Trennung wird serverseitig durchgesetzt: jede fachliche Datenbankabfrage trägt die Kennung der Organisation als Bedingung, und automatisierte Tests belegen, dass ein Zugriff über die Grenze scheitert.

### 10. Drittlandübermittlung

⟪WENN:ki-aus⟫
**Es findet keine Übermittlung in ein Drittland außerhalb der EU und des EWR statt.** Server, Datenbank, Dateiablage und Sicherungen liegen in [[REGION_DER_VERARBEITUNG]].
⟪ENDE⟫
⟪WENN:ki⟫
Für die in Abschnitt 11 beschriebene KI-Funktion können Daten an [[NAME_DES_KI_ANBIETERS]] mit Sitz in [[SITZ_DES_KI_ANBIETERS]] übermittelt werden. Grundlage der Übermittlung ist [[UEBERMITTLUNGSGRUNDLAGE]] Eine Kopie der Garantien kann unter [[KONTAKT_FUER_GARANTIEN]] angefordert werden.
⟪ENDE⟫

### 11. KI-gestützte Formularerstellung

⟪WENN:ki-aus⟫
Diese Installation nutzt **keine** KI-Funktion. Sie ist abgeschaltet; ohne hinterlegten Zugangsschlüssel ist sie in der Anwendung nicht vorhanden.
⟪ENDE⟫
⟪WENN:ki⟫
Bearbeitende können sich einen **Formularentwurf** aus einem selbst getippten Text erzeugen lassen.

**Wichtig für Ausfüllende:** Von dieser Funktion sind **keine Antwortdaten, keine Teilnehmerdaten und keine Organisationsdaten** betroffen. Verarbeitet wird ausschließlich der Text, den eine bearbeitende Person selbst eingibt, um ein Formular zu entwerfen. Automatisierte Tests belegen, dass nichts anderes die Anwendung verlässt.

| Frage | Antwort |
|---|---|
| Anbieter und Modell | [[NAME_DES_KI_ANBIETERS]], Modell [[KI_MODELL]] |
| Verarbeitungsregion | [[KI_REGION]] |
| Was hinausgeht | der eingegebene Text, eine Sprachkennung sowie Kennung und Version der verwendeten Programmbibliothek. Angaben zum Rechner werden ausdrücklich unterdrückt. |
| Was nicht hinausgeht | Antworten, Anlagen, Namen und Adressen von Teilnehmenden, Angaben zur Organisation |
| Rechtsgrundlage | Art. 6 Abs. 1 lit. f DSGVO |
| Aufbewahrung bei uns | der eingegebene Text **30 Tage**, dann physisch gelöscht; die Zuordnung der Nutzungszeile zu einer Person nach **12 Monaten** entfernt |
| Aufbewahrung beim Anbieter | richtet sich nach dem Auftragsverarbeitungsvertrag: [[KI_AUFBEWAHRUNG_BEIM_ANBIETER]] |

Mit [[NAME_DES_KI_ANBIETERS]] besteht ein Auftragsverarbeitungsvertrag nach Art. 28 DSGVO.
⟪ENDE⟫

### 12. Ihre Rechte

Sie haben gegenüber der jeweils verantwortlichen Stelle das Recht auf

- **Auskunft** über die zu Ihnen verarbeiteten Daten (Art. 15),
- **Berichtigung** unrichtiger Daten (Art. 16),
- **Löschung** (Art. 17),
- **Einschränkung der Verarbeitung** (Art. 18),
- **Datenübertragbarkeit**, soweit die Verarbeitung auf Einwilligung oder Vertrag beruht und automatisiert erfolgt (Art. 20),
- **Widerspruch** gegen eine Verarbeitung, die auf ein berechtigtes Interesse gestützt ist (Art. 21),
- **Widerruf einer Einwilligung** mit Wirkung für die Zukunft (Art. 7 Abs. 3).

Geht es um die **Inhalte eines Formulars** — Ihre Antworten, Ihre Anlagen, eine Bestätigungsmail —, wenden Sie sich an die Organisation, die das Formular anbietet; sie steht in der Fußzeile des Formulars. Geht es um den **Betrieb** — Ihr Konto, Protokolle, Sicherungen —, an [[NAME_DES_BETREIBERS]] unter [[E_MAIL_FUER_DATENSCHUTZANFRAGEN]]. Im Zweifel genügt eine Anfrage an [[E_MAIL_FUER_DATENSCHUTZANFRAGEN]]; sie wird weitergeleitet.

Ausfüllende haben **kein Konto**. Es gibt daher keine Abfrage „alle Daten zu Person X". Bitte nennen Sie in einem Auskunfts- oder Löschersuchen das **Formular** und möglichst den **ungefähren Zeitpunkt** — sonst lässt sich Ihre Eingabe nicht auffinden.

**Beschwerderecht.** Sie können sich bei einer Datenschutz-Aufsichtsbehörde beschweren, insbesondere bei der des Bundeslandes Ihres gewöhnlichen Aufenthalts oder bei der für [[NAME_DES_BETREIBERS]] zuständigen.

⟪WENN:aufsichtsbehoerde⟫
Zuständig für [[NAME_DES_BETREIBERS]] ist: [[AUFSICHTSBEHOERDE]]
⟪ENDE⟫

### 13. Änderungen dieser Erklärung

Diese Erklärung wird angepasst, wenn sich die Verarbeitung ändert — etwa wenn die KI-Funktion eingeschaltet oder ein Dienstleister gewechselt wird. Es gilt jeweils die hier abrufbare Fassung; der Stand steht oben.`,
  fixed: null,
  emptyBody: `**Für den Betrieb dieser Installation sind bislang keine Datenschutzangaben hinterlegt.**

Das heißt: Wer für den technischen Betrieb verantwortlich ist, an wen Sie sich mit einem Auskunfts- oder Löschersuchen wenden können und welche Dienstleister beteiligt sind, kann Ihnen diese Seite nicht sagen.

Was diese Anwendung technisch tut, gilt davon unabhängig und ist nachprüfbar: Beim Ausfüllen eines Formulars werden **keine Cookies gesetzt**, es wird **nichts in Ihrem Browser gespeichert**, und es werden **keine Inhalte von Dritten geladen**. Ihre IP-Adresse wird ausschließlich zum Schutz vor Überlastung im Arbeitsspeicher gehalten, nicht in der Datenbank gespeichert und nicht protokolliert.

Wofür die Angaben aus einem einzelnen Formular verwendet werden, entscheidet immer die Organisation, die es anbietet — nicht der Betrieb dieser Plattform. Ihre Datenschutzhinweise sind in der Fußzeile des jeweiligen Formulars verlinkt.`,
  /*
    **Die Reihenfolge dieser Liste ist die des Formulars, nicht die des
    Textes** (Review-Runde 4 Nr. 7).

    Der Befund: „Mailserver und Backup Felder haben falsche Reihenfolge und
    werden vermischt." Er stimmte, und die Ursache war eine Ordnung, die
    vernünftig aussah: die Felder standen in der Reihenfolge, in der sie im
    Text vorkommen. Der Text springt zu Recht — der Mailversand ist Abschnitt
    6, die Sicherungen sind 7, der Maildienstleister taucht in der
    Empfängertabelle in 9 noch einmal auf. Wer das Formular ausfüllt, liest
    den Text daneben aber nicht; für ihn standen drei Mailfelder mit zwei
    Sicherungsfeldern dazwischen.

    Jetzt gruppiert `group` sie fachlich, und die Liste steht in der
    Reihenfolge, in der das Formular sie zeigt. Für das Rendern ändert das
    nichts: der Text findet seine Werte über den Schlüssel und nicht über die
    Position.
  */
  slots: [
    {
      key: 'STAND',
      label: 'Stand der Erklärung',
      hint: 'Ein Datum. Eine Datenschutzerklärung ohne Stand ist wertlos, weil niemand weiß, welche Fassung gilt.',
      example: '1. Januar 2026',
      group: 'Verantwortliche Stelle',
    },
    {
      key: 'NAME_DES_BETREIBERS',
      label: 'Name des Betreibers',
      example: 'Musterverein e. V.',
      group: 'Verantwortliche Stelle',
    },
    ...addressSlots('Verantwortliche Stelle'),
    {
      key: 'E_MAIL_FUER_DATENSCHUTZANFRAGEN',
      label: 'E-Mail-Adresse für Datenschutzanfragen',
      hint: 'An diese Adresse gehen Auskunfts- und Löschersuchen. Sie darf dieselbe sein wie die des Impressums.',
      example: 'datenschutz@musterverein.example',
      group: 'Verantwortliche Stelle',
    },
    phoneSlot('Verantwortliche Stelle'),
    {
      key: 'DATENSCHUTZBEAUFTRAGTER',
      label: 'Datenschutzbeauftragte Person (Name und Kontaktweg)',
      hint: 'Nur, wenn eine bestellt ist — den Abschnitt schaltet die Auswahl darüber. Die Bestellpflicht folgt aus Art. 37 DSGVO und § 38 BDSG.',
      example:
        'Erika Mustermann, datenschutzbeauftragte@musterverein.example, +49 30 123456-9',
      multiline: true,
      group: 'Verantwortliche Stelle',
    },

    // ---- Konten der Bearbeitenden (Abschnitt 5) --------------------------
    //
    // Die drei Felder, die Review-Runde 4 Nr. 5 namentlich als unklar nannte,
    // stehen hier beieinander — mit einem übernehmbaren Standardtext, weil
    // die übliche Antwort für fast jeden Betreiber stimmt und nur bestätigt
    // werden muss.
    {
      key: 'VEREINBARUNG_ART_26',
      label: 'Wesentliches der Vereinbarung nach Art. 26 DSGVO',
      hint: 'Art. 26 Abs. 2 verlangt, dass das Wesentliche der Vereinbarung den betroffenen Personen zur Verfügung gestellt wird — also in zwei, drei Sätzen: wer entscheidet worüber, wer erfüllt die Betroffenenrechte, wer meldet eine Datenschutzverletzung. Der Vorschlag gibt die Aufteilung wieder, die in den Nutzungsbedingungen für Organisationen steht (docs/legal/vorlagen/07); wer davon abweicht, schreibt seine eigene hin.',
      suggestion:
        'Die Organisation entscheidet, wen sie einlädt und welche Rechte sie vergibt; der Betreiber entscheidet über Anmeldeverfahren, Sitzungsdauer und den Versand der Kontomails. Betroffenenrechte erfüllen beide, die zentrale Anlaufstelle steht unten. Eine Datenschutzverletzung meldet der Betreiber an die Aufsichtsbehörde und unterrichtet die Organisation unverzüglich.',
      multiline: true,
      group: 'Konten der Bearbeitenden',
    },
    {
      key: 'ANLAUFSTELLE',
      label: 'Zentrale Anlaufstelle nach Art. 26 Abs. 1',
      hint: 'Eine Adresse — an wen sich jemand wendet, der nicht entscheiden will, ob sein Anliegen den Betrieb oder die Organisation betrifft. Art. 26 Abs. 3 lässt ihn ohnehin bei beiden ansetzen; diese Angabe erspart ihm die Frage. Im Regelfall dieselbe Adresse wie oben für Datenschutzanfragen.',
      example: 'datenschutz@musterverein.example',
      group: 'Konten der Bearbeitenden',
    },
    {
      key: 'SITZUNGSDAUER',
      label: 'Sitzungsdauer in Stunden',
      hint: 'Der Wert der Umgebungsvariable SESSION_TTL_HOURS dieser Installation.',
      example: '12',
      group: 'Konten der Bearbeitenden',
    },
    {
      key: 'RECHTSGRUNDLAGE_KONTEN',
      label: 'Rechtsgrundlage für die Konten',
      hint: 'Gemeint sind die Konten der Bearbeitenden, nicht die Formularantworten. Ein Verein oder ein Unternehmen stützt sie auf Art. 6 Abs. 1 lit. b DSGVO — das Nutzungsverhältnis mit der bearbeitenden Person. Eine öffentliche Stelle nennt stattdessen die Landesregelung, die ihr die Aufgabe zuweist.',
      suggestion:
        'Die Konten der Bearbeitenden werden auf Grundlage von Art. 6 Abs. 1 lit. b DSGVO geführt: sie sind für die Durchführung des Nutzungsverhältnisses mit der jeweiligen Person erforderlich.',
      multiline: true,
      group: 'Konten der Bearbeitenden',
    },

    // ---- E-Mail-Versand (Abschnitt 6 und die Empfängertabelle in 9) ------
    {
      key: 'MAILSERVER_ODER_DIENSTLEISTER',
      label: 'Mailserver oder Maildienstleister',
      hint: 'Wie der Satz im Text weitergeht: „Der Versand läuft über …". Ein eigener Server oder ein Dienstleister — der Name genügt.',
      example: 'den Mailserver von Musterverein e. V.',
      group: 'E-Mail-Versand',
    },
    {
      key: 'NAME_DES_MAILDIENSTLEISTERS',
      label: 'Name des Maildienstleisters',
      hint: 'Für die Empfängertabelle. Wer den Versand selbst betreibt, trägt hier den eigenen Namen ein.',
      example: 'Muster Mail GmbH',
      group: 'E-Mail-Versand',
    },
    {
      key: 'ORT_DES_MAILDIENSTLEISTERS',
      label: 'Ort des Maildienstleisters',
      example: 'Musterstadt, Deutschland',
      group: 'E-Mail-Versand',
    },

    // ---- Datensicherung (Abschnitt 7) -----------------------------------
    {
      key: 'AUFBEWAHRUNG_SICHERUNGEN',
      label: 'Aufbewahrung der Sicherungen in Tagen',
      hint: 'Der Wert der Umgebungsvariable BACKUP_KEEP_DAYS dieser Installation.',
      example: '30',
      group: 'Datensicherung',
    },
    {
      key: 'ORT_DER_SICHERUNGEN',
      label: 'Aufbewahrungsort der Sicherungen',
      example:
        'verschlüsselter Objektspeicher der Muster Hosting GmbH, Musterstadt',
      group: 'Datensicherung',
    },

    // ---- Server und Betrieb (Abschnitte 3.1, 8, 9 und 10) ---------------
    {
      key: 'AUSSAGE_ZUM_ZUGANGSSERVER',
      label: 'Protokollierung durch den Zugangsserver',
      hint: 'Der Reverse-Proxy oder Load-Balancer vor der Anwendung. Was er protokolliert, entscheidet nicht die Anwendung, sondern der Betrieb — deshalb die Frage.',
      example:
        'Zugriffsprotokolle werden dort für 7 Tage aufbewahrt und danach automatisch gelöscht.',
      multiline: true,
      group: 'Server und Betrieb',
    },
    {
      key: 'NAME_DES_HOSTERS',
      label: 'Name des Hosters',
      example: 'Muster Hosting GmbH',
      group: 'Server und Betrieb',
    },
    {
      key: 'ORT_DES_RECHENZENTRUMS',
      label: 'Ort des Rechenzentrums',
      example: 'Musterstadt, Deutschland',
      group: 'Server und Betrieb',
    },
    {
      key: 'REGION_DER_VERARBEITUNG',
      label: 'Region der Verarbeitung',
      hint: 'Steht im Satz „Server, Datenbank, Dateiablage und Sicherungen liegen in …".',
      example: 'Deutschland',
      group: 'Server und Betrieb',
    },
    {
      key: 'ALARM_ADRESSE',
      label: 'Adresse für Betriebsalarme',
      hint: 'Dieselbe Adresse, die in den Systemeinstellungen unter „Betriebsalarme" steht.',
      example: 'betrieb@musterverein.example',
      group: 'Server und Betrieb',
    },
    {
      key: 'WEITERE_DIENSTLEISTER',
      label: 'Weitere Auftragsverarbeiter',
      hint: 'Je Zeile einer, mit Zweck und Ort.',
      example:
        'Muster Wartung GmbH, Fernwartung der Server, Musterstadt\nMuster Archiv AG, Auslagerung der Sicherungen, Musterstadt',
      multiline: true,
      group: 'Server und Betrieb',
    },

    // ---- KI-Funktion (Abschnitte 10 und 11) -----------------------------
    {
      key: 'NAME_DES_KI_ANBIETERS',
      label: 'Name des KI-Anbieters',
      example: 'Anthropic PBC',
      group: 'KI-Funktion',
    },
    {
      key: 'SITZ_DES_KI_ANBIETERS',
      label: 'Sitz des KI-Anbieters',
      example: 'Vereinigte Staaten von Amerika',
      group: 'KI-Funktion',
    },
    {
      key: 'KI_MODELL',
      label: 'KI-Modell',
      hint: 'Das Modell, das in den Systemeinstellungen unter „KI" hinterlegt ist.',
      example: 'claude-sonnet-4-5',
      group: 'KI-Funktion',
    },
    {
      key: 'KI_REGION',
      label: 'KI-Verarbeitungsregion',
      example: 'Vereinigte Staaten von Amerika',
      group: 'KI-Funktion',
    },
    {
      key: 'UEBERMITTLUNGSGRUNDLAGE',
      label: 'Grundlage der Drittlandübermittlung',
      hint: 'Angemessenheitsbeschluss oder Standardvertragsklauseln nach Art. 46 Abs. 2 lit. c — bei Standardvertragsklauseln zusätzlich die getroffenen Maßnahmen nennen. Vor dem Einschalten prüfen, nicht danach.',
      example:
        'der Abschluss der Standardvertragsklauseln nach Art. 46 Abs. 2 lit. c DSGVO nebst Verschlüsselung der Übertragung und Beschränkung der übermittelten Daten auf den eingegebenen Entwurfstext.',
      multiline: true,
      group: 'KI-Funktion',
    },
    {
      key: 'KONTAKT_FUER_GARANTIEN',
      label: 'Kontakt für eine Kopie der Garantien',
      hint: 'Wer die Standardvertragsklauseln auf Anfrage herausgibt. Im Regelfall dieselbe Adresse wie für Datenschutzanfragen.',
      example: 'datenschutz@musterverein.example',
      group: 'KI-Funktion',
    },
    {
      key: 'KI_AUFBEWAHRUNG_BEIM_ANBIETER',
      label: 'Aufbewahrung beim KI-Anbieter',
      hint: 'Was der Auftragsverarbeitungsvertrag mit dem Anbieter dazu sagt.',
      example:
        'Der Anbieter bewahrt die übermittelten Texte nach dem Auftragsverarbeitungsvertrag höchstens 30 Tage zur Missbrauchserkennung auf und verwendet sie nicht zum Training von Modellen.',
      multiline: true,
      group: 'KI-Funktion',
    },

    // ---- Beschwerderecht (Abschnitt 12) ---------------------------------
    //
    // ⚠️ **Kein Pflichtfeld mehr** (Review-Runde 4 Nr. 6). Warum, steht an
    // der Bedingung `aufsichtsbehoerde` unten.
    {
      key: 'AUFSICHTSBEHOERDE',
      label: 'Zuständige Datenschutz-Aufsichtsbehörde (Name und Anschrift)',
      hint: 'Die Aufsicht am Sitz des Betreibers. Bei kirchlichen Trägern die Datenschutzaufsicht der EKD bzw. der katholischen Kirche, nicht die staatliche.',
      example:
        'Landesbeauftragte für den Datenschutz Musterland, Musterstraße 1, 12345 Musterstadt',
      multiline: true,
      group: 'Beschwerderecht',
    },
  ],
  conditions: [
    {
      key: 'datenschutzbeauftragter',
      label: 'Eine datenschutzbeauftragte Person ist bestellt',
    },
    {
      key: 'kein-datenschutzbeauftragter',
      label: 'Ausdrücklich sagen, dass keine bestellt ist',
      hint: 'Die Bestellpflicht folgt aus Art. 37 DSGVO und § 38 BDSG — bei öffentlichen Stellen praktisch immer. Diese Aussage ist zu prüfen, nicht zu übernehmen.',
    },
    {
      key: 'aufsichtsbehoerde',
      label:
        'Die zuständige Datenschutz-Aufsichtsbehörde soll namentlich stehen',
      hint: 'Freiwillig (Review-Runde 4 Nr. 6). Art. 13 Abs. 2 lit. d DSGVO verlangt den Hinweis auf das Beschwerderecht, nicht die Nennung einer bestimmten Behörde — und der Hinweis steht ohnehin da. Wer die eigene Aufsicht nennt, erspart der beschwerdeführenden Person die Suche; wer sie nicht sicher kennt, lässt es besser, denn eine falsch benannte Behörde ist schlechter als keine.',
    },
    {
      key: 'sso',
      label:
        'Mindestens eine Organisation meldet über einen eigenen Anmeldedienst an',
    },
    {
      key: 'weitere-dienstleister',
      label: 'Es gibt weitere Auftragsverarbeiter',
    },
    {
      key: 'ki',
      label: 'Die KI-Funktion ist eingerichtet',
      hint: 'Wird automatisch aus der KI-Konfiguration dieser Installation gesetzt und lässt sich hier nicht abwählen — ein Absatz über eine Verarbeitung, die nicht stattfindet, wäre eine Falschangabe, und einer über eine, die stattfindet, fehlte sonst.',
      auto: 'ai',
    },
    {
      key: 'ki-aus',
      label: 'Die KI-Funktion ist nicht eingerichtet',
      hint: 'Die Gegenprobe zu „KI-Funktion eingerichtet" — ebenfalls automatisch gesetzt.',
      auto: 'ai-off',
    },
  ],
};

// ---------------------------------------------------------------------------
// Template 02 — provider details of an organisation
// ---------------------------------------------------------------------------

/**
 * The part that stands **fixed in the code** in an organisation's provider
 * details: who does the technical operation.
 *
 * Not editable, for the same reason that part B of template 04 is not — it
 * describes a division of responsibility the organisation does not determine.
 * An organisation that could change it could declare the operation its
 * vicarious agent or conceal it altogether.
 */
/**
 * **Der Satz über einem hinterlegten Verweis** (`mode: 'link'`, Review-Runde 5,
 * Nachtrag) — einer für alle fünf Seiten.
 *
 * Er steht hier bei den übrigen Wortlauten und nicht im Renderer: was eine Seite
 * sagt, steht in dieser Datei, auch wenn es nur zwei Zeilen sind.
 *
 * **Bewusst ohne Titel und ohne Namen.** Beides steht bereits über ihm — die
 * Überschrift der Seite und die Zeile „Verantwortlich für dieses Formular: …"
 * (`LegalPageView`). Ein Satz, der beides noch einmal einsetzte, müsste den
 * Artikel jedes der fünf Titel treffen („**Das** Impressum", „**Die**
 * Anbieterangaben") und wäre fünf Wortlaute statt einem.
 *
 * ⚠️ **Kein `[[…]]`.** Die Adresse setzt {@link renderLegalPage} als
 * Link-Auszeichnung darunter — sie ist keine ausgefüllte Vorlagenstelle,
 * sondern eine eigene Hälfte des Dokuments.
 */
export const LEGAL_LINK_LEAD =
  'Diese Angaben stehen auf einer eigenen Seite. Der folgende Link führt dorthin:';

const TENANT_IMPRINT_FIXED = `### Technischer Betrieb

Die technische Bereitstellung dieses Formulars erfolgt durch [[APP_NAME_DES_BETREIBERS]] im Auftrag von [[APP_NAME_DER_ORGANISATION]]. Angaben zum technischen Betrieb stehen im [Impressum des Betreibers]([[APP_ADRESSE_IMPRESSUM]]) und in dessen [Datenschutzerklärung]([[APP_ADRESSE_DATENSCHUTZ]]).`;

const TENANT_IMPRINT: LegalTemplate = {
  key: 'tenant:imprint',
  title: 'Anbieterangaben',
  purpose:
    'Wer für die Formulare dieser Organisation verantwortlich ist — verlinkt aus der Fußzeile jeder öffentlichen Seite unter „Verantwortlich für dieses Formular". Rechtsgrundlage: § 18 Abs. 1 MStV und Art. 13 Abs. 1 lit. a DSGVO.',
  body: `### Verantwortliche Stelle

[[APP_NAME_DER_ORGANISATION]]
⟪WENN:juristische-person⟫[[RECHTSFORM]]⟪ENDE⟫
[[STRASSE_UND_HAUSNUMMER]]
[[PLZ]] [[ORT]]
[[LAND]]

⟪WENN:juristische-person⟫
**Vertreten durch:** [[VERTRETUNGSBERECHTIGTE]]
⟪ENDE⟫

### Kontakt

Telefon: [[TELEFONNUMMER]]
E-Mail: [[E_MAIL_ADRESSE]]

⟪WENN:registereintrag⟫
### Registereintrag

Registergericht: [[REGISTERGERICHT]]
Registernummer: [[REGISTERNUMMER]]
⟪ENDE⟫

### Fragen zum Datenschutz

Wie [[APP_NAME_DER_ORGANISATION]] mit den Angaben aus diesem Formular umgeht, steht in den [Datenschutzhinweisen]([[APP_ADRESSE_ORG_DATENSCHUTZ]]).

⟪WENN:datenschutzbeauftragter⟫
Datenschutzbeauftragte Person: [[DATENSCHUTZBEAUFTRAGTER]]
⟪ENDE⟫`,
  fixed: TENANT_IMPRINT_FIXED,
  emptyBody: `**Für dieses Formular sind bislang keine Anbieterangaben hinterlegt.**

Das Formular wird bereitgestellt von der Organisation **[[APP_NAME_DER_ORGANISATION]]**. Weitere Angaben zu ihr — Anschrift, Vertretung, Kontaktweg — liegen dieser Installation nicht vor.

**Wenn Sie die Organisation erreichen müssen** — etwa um Auskunft über Ihre Daten zu verlangen oder deren Löschung —, wenden Sie sich an den Betrieb dieser Plattform. Wie er erreichbar ist, steht im [Impressum]([[APP_ADRESSE_IMPRESSUM]]). Er ist verpflichtet, Ihr Anliegen unverzüglich an die verantwortliche Organisation weiterzuleiten.

Welche Daten die Anwendung technisch verarbeitet und wie lange sie gespeichert bleiben, steht unabhängig davon in den [Datenschutzhinweisen]([[APP_ADRESSE_ORG_DATENSCHUTZ]]).`,
  slots: [
    {
      key: 'RECHTSFORM',
      label: 'Rechtsform',
      hint: 'Nur bei juristischen Personen und Personengesellschaften.',
      example: 'eingetragener Verein',
    },
    ...addressSlots(),
    { key: 'LAND', label: 'Land', example: 'Deutschland' },
    {
      key: 'VERTRETUNGSBERECHTIGTE',
      label: 'Vertretungsberechtigte Person(en)',
      example: 'Erika Mustermann (Vorsitzende)',
    },
    phoneSlot(),
    {
      key: 'E_MAIL_ADRESSE',
      label: 'E-Mail-Adresse',
      hint: 'Muss unmittelbare Kommunikation erlauben. Über diese Adresse erreichen Teilnehmende euch mit einem Auskunfts- oder Löschersuchen.',
      example: 'kontakt@musterverein.example',
    },
    {
      key: 'REGISTERGERICHT',
      label: 'Registergericht',
      example: 'Amtsgericht Musterstadt',
    },
    {
      key: 'REGISTERNUMMER',
      label: 'Registernummer',
      example: 'VR 12345',
    },
    {
      key: 'DATENSCHUTZBEAUFTRAGTER',
      label: 'Datenschutzbeauftragte Person (Name und Kontaktweg)',
      example:
        'Erika Mustermann, datenschutzbeauftragte@musterverein.example, +49 30 123456-9',
      multiline: true,
    },
  ],
  conditions: [
    {
      key: 'juristische-person',
      label:
        'Die Organisation ist eine juristische Person oder Personengesellschaft',
    },
    {
      key: 'registereintrag',
      label: 'Die Organisation ist in ein Register eingetragen',
    },
    {
      key: 'datenschutzbeauftragter',
      label: 'Eine datenschutzbeauftragte Person ist bestellt',
    },
  ],
};

// ---------------------------------------------------------------------------
// Template 04 — privacy notice of an organisation
// ---------------------------------------------------------------------------

/**
 * **Part B and part C of template 04 — fixed in the code.**
 *
 * The template says why itself: „Nicht bearbeitbar machen. Dieser Teil
 * beschreibt das Verhalten der Software. […] Eine Organisation, die ihn ändern
 * könnte, könnte etwas Unrichtiges über eine Software behaupten, die sie nicht
 * kontrolliert."
 *
 * And it is displayed **even when part A is empty** — it is true regardless of
 * whether anybody has entered something. That is half of the answer to „was
 * steht auf einer leeren Seite?" from section 5.4.
 */
const TENANT_PRIVACY_FIXED = `## Wie diese Anwendung Ihre Angaben technisch verarbeitet

Dieser Teil beschreibt das Verhalten der Software. Er ist für jede Organisation dieser Installation gleich und wird von keiner Organisation geschrieben.

### Auftragsverarbeitung

Dieses Formular läuft auf einer Installation der Software **Formsache**, betrieben von [[APP_NAME_DES_BETREIBERS]] im Auftrag von [[APP_NAME_DER_ORGANISATION]] (Auftragsverarbeitung nach Art. 28 DSGVO). Der Betreiber verarbeitet Ihre Angaben ausschließlich weisungsgebunden und nicht für eigene Zwecke.

**Sie brauchen kein Benutzerkonto.** Es wird keines angelegt, und es wird auch keines im Hintergrund geführt.

### Was beim Aufrufen der Seite geschieht

- **Es werden keine Cookies gesetzt.** Auch kein „technisch notwendiges".
- **Es wird nichts in Ihrem Browser gespeichert** — weder im lokalen noch im Sitzungsspeicher. Auch das Kennwort eines geschützten Formulars nicht.
- **Es werden keine Inhalte von Dritten geladen.** Schriften, Bilder und Programmcode kommen ausschließlich von diesem Server. Es gibt keine Reichweitenmessung, keine Analyse, kein Tracking, keine Einbettungen und keine automatisierte Entscheidungsfindung.
- **Ihre IP-Adresse** wird nur zum Schutz vor Überlastung und automatisiertem Missbrauch verwendet, dabei ausschließlich im Arbeitsspeicher gehalten (längstens zwei Minuten, bei Datei-Uploads längstens eine Stunde), nicht in der Datenbank gespeichert und nicht protokolliert.

Deshalb ist für dieses Formular **keine Einwilligung nach § 25 TDDDG** nötig, und deshalb sehen Sie keinen Cookie-Hinweis.

### Welche Daten gespeichert werden, und wie lange

| Was | Wo | Wie lange |
|---|---|---|
| **Ihre Antworten** — genau die Angaben, nach denen gefragt wurde | Datenbank | bis die Organisation sie löscht. Nach dem Löschen liegen sie **30 Tage** im Papierkorb der Organisation und werden dann endgültig entfernt |
| Zeitpunkt der Absendung, die Fassung des Formulars, ein Zugangsschlüssel zum Bearbeiten | Datenbank | mit der Antwort |
| **Hochgeladene Dateien** (PDF, PNG, JPG; je höchstens 10 MB, höchstens 10 je Antwort) | Dateiablage | mit der Antwort. Eine Datei, die hochgeladen, aber nie abgesendet wurde, wird nach **24 Stunden** gelöscht |
| **Ein zwischengespeicherter Entwurf**, wenn Sie das Ausfüllen unterbrechen | Datenbank | **30 Tage**, oder früher, wenn die Frist des Formulars vorher endet. Sie können ihn jederzeit selbst verwerfen |
| **Versandprotokoll** zu jeder E-Mail: Empfängeradresse, Betreff, der Text der Nachricht, Status | Datenbank | **90 Tage**, dann physisch gelöscht. Wird Ihre Antwort endgültig gelöscht, werden die personenbezogenen Spalten sofort geleert |

**Bei Bildern werden die Metadaten beim Hochladen entfernt** — bei JPEG die EXIF-, XMP- und IPTC-Blöcke, bei PNG die Textabschnitte. Ein Foto vom Mobiltelefon trägt regelmäßig GPS-Koordinaten, Gerätemodell und Seriennummer; die kommen nicht mit.

**Bei PDF-Dateien geschieht das nicht.** Ein PDF wird unverändert gespeichert, einschließlich seiner Metadaten (Autorenname, verwendete Software, Erstellungsdatum, unter Umständen frühere Bearbeitungsstände). Laden Sie nur Dokumente hoch, die Sie kennen, und nur das, wonach ausdrücklich gefragt wurde.

### Wer die Angaben sehen kann

- **Innerhalb der Organisation:** die Personen, denen sie das Recht zum Ansehen von Antworten erteilt hat. Der Zugriff wird serverseitig geprüft.
- **Eine Grenze, die wir benennen statt sie zu beschönigen:** Das **Versandprotokoll** ist organisationsweit und nicht auf ein einzelnes Formular beschränkt. Wer das Recht hat, es einzusehen, kann darüber die versendeten Nachrichten aller Formulare sehen, für die er nicht ausdrücklich gesperrt ist — und diese Nachrichten enthalten den Text, der aus Ihren Antworten erzeugt wurde.
- **Der Betrieb dieser Plattform**, soweit es für Betrieb, Störungsbeseitigung und Datensicherung erforderlich ist. Er ist zur Vertraulichkeit verpflichtet und darf die Angaben nicht für eigene Zwecke verwenden.
- **Der Betreiber des Mailservers**, über den Benachrichtigungen versendet werden, soweit eine Nachricht Angaben aus Ihrer Antwort enthält.
- **Andere Organisationen dieser Installation sehen nichts.** Die Trennung wird serverseitig durchgesetzt und durch automatisierte Tests belegt, die den unerlaubten Zugriff scheitern sehen.
- **Hochgeladene Dateien werden nicht per E-Mail versendet.**

### Der Link zum Bearbeiten Ihrer Antwort

Erlaubt das Formular es, enthält Ihre Bestätigung einen Link, über den Sie Ihre Antwort später ansehen und ändern können.

**Dieser Link ist der Schlüssel zu Ihrer Antwort.** Wer ihn hat, sieht Ihre Angaben — ohne Kennwort und ohne Anmeldung. Er ist **unbefristet gültig**, solange Ihre Antwort besteht und die Organisation das Bearbeiten nicht abschaltet.

**Was das für Sie heißt:** Leiten Sie die Bestätigungsmail nicht weiter. Nutzen Sie ein Postfach, auf das nur Sie Zugriff haben — nicht ein geteiltes Vereins- oder Abteilungspostfach. Dasselbe gilt für den Link zu einem zwischengespeicherten Entwurf.

Die Anwendung schützt die Adresse insoweit, als sie beim Anklicken eines Links auf der Seite nicht an das Ziel weitergegeben wird. Gegen eine Weiterleitung der E-Mail selbst schützt das nicht.

⟪WENN:weiterleitung⟫
### Weiterleitung nach dem Absenden

Bei manchen Formularen dieser Organisation werden Sie nach dem Absenden auf eine fremde Adresse weitergeleitet. Damit wird Ihre IP-Adresse an den Betreiber der Zielseite übertragen. Welche Daten dort verarbeitet werden, bestimmt dessen Datenschutzerklärung; die Formularadresse selbst wird nicht mit übertragen.

**Wohin ein einzelnes Formular weiterleitet**, nennt der Datenschutzhinweis dieses Formulars, sofern die Organisation dort einen hinterlegt hat.
⟪ENDE⟫

### Datensicherung

Die Installation wird verschlüsselt gesichert. Wird Ihre Antwort endgültig gelöscht, verschwindet sie aus dem laufenden Betrieb; in Sicherungen, die vorher erstellt wurden, bleibt sie bis zum Ablauf der Aufbewahrungsfrist enthalten. Wird eine Sicherung eingespielt, wird die Löschung erneut vorgenommen. Wie lange Sicherungen aufbewahrt werden, steht in der [Datenschutzerklärung des Betreibers]([[APP_ADRESSE_DATENSCHUTZ]]).

### Drittländer

⟪WENN:ki-aus⟫
Ihre Angaben werden ausschließlich innerhalb der EU und des EWR verarbeitet. Eine Übermittlung in ein Drittland findet nicht statt.
⟪ENDE⟫
⟪WENN:ki⟫
Diese Installation nutzt eine KI-Funktion, mit der bearbeitende Personen Formularentwürfe erzeugen. **Ihre Antworten sind davon nicht betroffen** — an den KI-Anbieter geht ausschließlich der Text, den eine bearbeitende Person selbst eingibt. Einzelheiten in der [Datenschutzerklärung des Betreibers]([[APP_ADRESSE_DATENSCHUTZ]]).
⟪ENDE⟫

## Ihre Rechte

Gegenüber [[APP_NAME_DER_ORGANISATION]] haben Sie das Recht auf **Auskunft** (Art. 15), **Berichtigung** (Art. 16), **Löschung** (Art. 17), **Einschränkung der Verarbeitung** (Art. 18), **Datenübertragbarkeit** (Art. 20, soweit die Verarbeitung auf Einwilligung oder Vertrag beruht) und **Widerspruch** (Art. 21, wenn die Verarbeitung auf ein berechtigtes Interesse gestützt ist).

Beruht eine Verarbeitung auf Ihrer Einwilligung, können Sie diese jederzeit mit Wirkung für die Zukunft widerrufen (Art. 7 Abs. 3). Die Rechtmäßigkeit der bis dahin erfolgten Verarbeitung bleibt unberührt.

**Bitte nennen Sie das Formular und den ungefähren Zeitpunkt.** Weil es für Ausfüllende **kein Konto** gibt, existiert keine Abfrage „alle Daten zu Person X". Ihre Angaben werden über das jeweilige Formular gesucht.

**Zwischengespeicherte Entwürfe sind für die Organisation nicht sichtbar.** Ein Entwurf ist ausschließlich über seine eigene Adresse erreichbar und erscheint in keiner Auskunft. Sie können ihn selbst über „Entwurf verwerfen" löschen. Verlangen Sie die sofortige Löschung eines Entwurfs, muss die Organisation dafür den Betrieb dieser Plattform einschalten.

Für den **technischen Betrieb** dieser Anwendung ist [[APP_NAME_DES_BETREIBERS]] verantwortlich; seine [Datenschutzerklärung]([[APP_ADRESSE_DATENSCHUTZ]]) beschreibt, was er für eigene Zwecke verarbeitet. Im Zweifel können Sie sich mit einem Anliegen an beide Stellen wenden.`;

const TENANT_PRIVACY: LegalTemplate = {
  key: 'tenant:privacy',
  title: 'Datenschutzhinweise',
  purpose:
    'Die Informationspflicht nach Art. 13 DSGVO gegenüber den Menschen, die ein Formular dieser Organisation ausfüllen. Ohne sie ist ein veröffentlichtes Formular rechtswidrig. Was die Software technisch tut, steht darunter und ist fest im Code.',
  body: `**Stand:** [[STAND]]

### Wer verantwortlich ist

Verantwortlich für die Verarbeitung der Angaben, die Sie in ein Formular dieser Organisation eintragen:

[[APP_NAME_DER_ORGANISATION]]
[[STRASSE_UND_HAUSNUMMER]]
[[PLZ]] [[ORT]]
E-Mail: [[E_MAIL_ADRESSE]]
Telefon: [[TELEFONNUMMER]]

⟪WENN:datenschutzbeauftragter⟫
**Datenschutzbeauftragte Person:** [[DATENSCHUTZBEAUFTRAGTER]]
⟪ENDE⟫

### Wofür wir Ihre Angaben verarbeiten, und auf welcher Grundlage

[[ZWECKE_UND_RECHTSGRUNDLAGEN]]

Die Software löscht Antworten **nicht von selbst**; sie kann nicht wissen, wann eine Anmeldung ihren Zweck erfüllt hat. Die genannten Fristen hält [[APP_NAME_DER_ORGANISATION]] selbst ein, indem sie die Antworten löscht.

### Welche Angaben Pflicht sind

[[PFLICHTANGABEN]]

### An wen wir Ihre Angaben weitergeben

[[EMPFAENGER]]

Über diese Empfänger hinaus verarbeitet [[APP_NAME_DES_BETREIBERS]] Ihre Angaben als technischer Dienstleister in unserem Auftrag; siehe unten.

⟪WENN:besondere-kategorien⟫
### Besondere Kategorien personenbezogener Daten

[[BESONDERE_KATEGORIEN]]
⟪ENDE⟫

⟪WENN:minderjaehrige⟫
### Wenn das Formular von Minderjährigen ausgefüllt wird

[[MINDERJAEHRIGE]]
⟪ENDE⟫

⟪WENN:angaben-zu-dritten⟫
### Wenn Sie Angaben zu anderen Personen machen

In diesem Formular können Sie Angaben zu **anderen Personen** machen — Begleitpersonen, Angehörige, Ansprechpartner. Diese Personen haben uns ihre Daten nicht selbst gegeben; für sie gilt Art. 14 DSGVO.

- **Wir verarbeiten diese Angaben** zu demselben Zweck und auf derselben Grundlage wie Ihre eigenen, und wir löschen sie zum selben Zeitpunkt.
- **Wir informieren die genannten Personen in der Regel nicht einzeln**, weil uns dafür regelmäßig keine Kontaktdaten vorliegen und der Aufwand außer Verhältnis stünde (Art. 14 Abs. 5 lit. b DSGVO). Diese Seite ist die Information, die an die Stelle der Einzelbenachrichtigung tritt.
- **Bitte nennen Sie nur Personen, von denen Sie wissen, dass es ihnen recht ist**, und nur die Angaben, die für den Zweck nötig sind.
- Wer hier genannt wurde, kann alle Rechte geltend machen — Auskunft, Berichtigung, Löschung, Widerspruch.
⟪ENDE⟫

### Beschwerderecht

Sie können sich bei einer Datenschutz-Aufsichtsbehörde beschweren, insbesondere bei der des Bundeslandes Ihres gewöhnlichen Aufenthalts oder bei der für [[APP_NAME_DER_ORGANISATION]] zuständigen.

⟪WENN:aufsichtsbehoerde⟫
Zuständig für [[APP_NAME_DER_ORGANISATION]] ist: [[AUFSICHTSBEHOERDE]]
⟪ENDE⟫

### Wie Sie Ihre Rechte geltend machen

Wenden Sie sich an [[APP_NAME_DER_ORGANISATION]], [[E_MAIL_ADRESSE]].`,
  fixed: TENANT_PRIVACY_FIXED,
  emptyBody: `**[[APP_NAME_DER_ORGANISATION]] hat für ihre Formulare noch keine eigenen Datenschutzhinweise hinterlegt.**

Das heißt: Wofür Ihre Angaben verwendet werden, auf welcher Rechtsgrundlage das geschieht und wie lange sie aufbewahrt werden, kann Ihnen diese Seite nicht sagen. Diese Auskunft schuldet Ihnen die Organisation (Art. 13 DSGVO); Sie können sie einfordern.

**Wie Sie die Organisation erreichen:** siehe die [Anbieterangaben]([[APP_ADRESSE_ORG_IMPRESSUM]]).

**Was diese Anwendung technisch mit Ihren Angaben tut** — welche Daten gespeichert werden, wie lange, wer sie sehen kann und dass keine Cookies gesetzt und keine Daten an Dritte übermittelt werden —, steht unabhängig davon in den folgenden Abschnitten.`,
  slots: [
    {
      key: 'STAND',
      label: 'Stand der Hinweise',
      hint: 'Ein Datum.',
      example: '1. Januar 2026',
      group: 'Verantwortliche Stelle',
    },
    ...addressSlots('Verantwortliche Stelle'),
    {
      key: 'E_MAIL_ADRESSE',
      label: 'E-Mail-Adresse',
      hint: 'An diese Adresse wenden sich Teilnehmende mit einem Auskunfts- oder Löschersuchen.',
      example: 'datenschutz@musterverein.example',
      group: 'Verantwortliche Stelle',
    },
    phoneSlot('Verantwortliche Stelle'),
    {
      key: 'DATENSCHUTZBEAUFTRAGTER',
      label: 'Datenschutzbeauftragte Person (Name und Kontaktweg)',
      hint: 'Nur, wenn eine bestellt ist — den Abschnitt schaltet die Auswahl darüber.',
      example:
        'Erika Mustermann, datenschutzbeauftragte@musterverein.example, +49 30 123456-9',
      multiline: true,
      group: 'Verantwortliche Stelle',
    },
    {
      key: 'ZWECKE_UND_RECHTSGRUNDLAGEN',
      label: 'Zwecke, Rechtsgrundlagen und Aufbewahrung',
      hint: 'Für jedes Formular eine eigene Zeile. „Verwaltung" ist kein Zweck; ein Zweck ist „Anmeldung zur Jahrestagung 2026 und deren Durchführung einschließlich Teilnehmerliste und Verpflegungsplanung". Genau eine Rechtsgrundlage je Zweck, nicht mehrere vorsorglich. Zur Aufbewahrung verlangt Art. 13 Abs. 2 lit. a die Dauer oder die Kriterien für ihre Festlegung — „so lange wie nötig" ist kein Kriterium.',
      example:
        'Anmeldung zur Jahrestagung 2026 samt Teilnehmerliste und Verpflegungsplanung — Art. 6 Abs. 1 lit. b DSGVO — gelöscht 3 Monate nach der Tagung\nBestandsmeldung der Mitgliedszahlen — Art. 6 Abs. 1 lit. c DSGVO in Verbindung mit § 8 der Satzung — gelöscht nach 10 Jahren',
      multiline: true,
      group: 'Was mit den Angaben geschieht',
    },
    {
      key: 'PFLICHTANGABEN',
      label: 'Pflichtangaben und die Folge ihres Fehlens',
      hint: 'Welche Felder Pflicht sind, worauf sich die Pflicht stützt (Vertrag, Gesetz, Satzung) und was geschieht, wenn eine Angabe ausbleibt — Art. 13 Abs. 2 lit. e.',
      example:
        'Name und E-Mail-Adresse sind zur Anmeldung erforderlich; ohne sie kann die Anmeldung nicht bearbeitet werden. Alle übrigen Angaben sind freiwillig.',
      multiline: true,
      group: 'Was mit den Angaben geschieht',
    },
    {
      key: 'EMPFAENGER',
      label: 'Empfänger der Angaben',
      hint: 'Häufig vergessen: die Tagungsstätte, eine übergeordnete Organisation, eine Behörde, ein Reisebüro, eine Versicherung, andere Teilnehmende bei einer öffentlichen Teilnehmerliste.',
      example:
        'Tagungshaus Musterberg gGmbH (Zimmer- und Verpflegungsplanung)\nMusterverband e. V. als Dachverband (aggregierte Teilnehmerzahlen, keine Namen)',
      multiline: true,
      group: 'Was mit den Angaben geschieht',
    },
    {
      key: 'BESONDERE_KATEGORIEN',
      label: 'Besondere Kategorien nach Art. 9 DSGVO',
      hint: 'Welche Angabe, welche Kategorie, welche Grundlage nach Art. 9 Abs. 2 und welcher Zweck. „Verpflegung: vegetarisch/vegan/halal/koscher" als Pflichtfeld ist eine Erhebung religiöser Daten — sie lässt sich fast immer durch ein freiwilliges Freitextfeld vermeiden.',
      example:
        'Angaben zu Unverträglichkeiten und Assistenzbedarf sind Gesundheitsdaten. Sie sind freiwillig, werden allein zur Planung der Verpflegung und der Unterbringung verwendet und beruhen auf Ihrer Einwilligung nach Art. 9 Abs. 2 lit. a DSGVO, die Sie jederzeit widerrufen können.',
      multiline: true,
      group: 'Besondere Fälle',
    },
    {
      key: 'MINDERJAEHRIGE',
      label: 'Umgang mit Minderjährigen',
      hint: 'Beruht die Verarbeitung auf einer Einwilligung, ist diese bei unter 16-Jährigen nur mit Zustimmung der Sorgeberechtigten wirksam (Art. 8 DSGVO). Die Software bietet dafür keinen Mechanismus.',
      example:
        'Für Teilnehmende unter 16 Jahren füllen die Sorgeberechtigten das Formular aus; ihre Zustimmung holen wir außerhalb dieser Anwendung schriftlich ein.',
      multiline: true,
      group: 'Besondere Fälle',
    },
    {
      key: 'AUFSICHTSBEHOERDE',
      label: 'Zuständige Datenschutz-Aufsichtsbehörde (Name und Anschrift)',
      hint: 'Die Aufsicht am Sitz der Organisation. Freiwillig — siehe die Auswahl darüber.',
      example:
        'Landesbeauftragte für den Datenschutz Musterland, Musterstraße 1, 12345 Musterstadt',
      multiline: true,
      group: 'Beschwerderecht',
    },
  ],
  conditions: [
    {
      key: 'datenschutzbeauftragter',
      label: 'Eine datenschutzbeauftragte Person ist bestellt',
    },
    {
      key: 'aufsichtsbehoerde',
      label:
        'Die zuständige Datenschutz-Aufsichtsbehörde soll namentlich stehen',
      hint: 'Freiwillig (Review-Runde 4 Nr. 6). Art. 13 Abs. 2 lit. d DSGVO verlangt den Hinweis auf das Beschwerderecht, nicht die Nennung einer bestimmten Behörde — und der Hinweis steht ohnehin da. Wer die eigene Aufsicht nennt, erspart der beschwerdeführenden Person die Suche; wer sie nicht sicher kennt, lässt es besser, denn eine falsch benannte Behörde ist schlechter als keine.',
    },
    {
      key: 'besondere-kategorien',
      label: 'Ein Formular erhebt besondere Kategorien nach Art. 9 DSGVO',
      hint: 'Verpflegungswünsche, Assistenzbedarf und Gesundheitsangaben gehören fast immer dazu, auch wenn sie nicht danach aussehen.',
    },
    {
      key: 'minderjaehrige',
      label: 'Ein Formular kann von Minderjährigen ausgefüllt werden',
    },
    {
      key: 'angaben-zu-dritten',
      label:
        'Freitext- oder Tabellenfelder können Angaben zu Dritten aufnehmen',
      hint: 'Ohne diesen Abschnitt trägt die Berufung auf Art. 14 Abs. 5 lit. b nicht.',
    },
    {
      key: 'weiterleitung',
      label:
        'Ein Formular leitet nach dem Absenden auf eine fremde Adresse weiter',
      hint: 'Nach der Zieladresse fragt diese Seite nicht: mehrere Formulare können verschiedene haben. Wohin ein einzelnes Formular weiterleitet, trägt die Anwendung selbst in dessen eigenen Datenschutzhinweis ein.',
    },
    {
      key: 'ki',
      label: 'Die KI-Funktion der Installation ist eingerichtet',
      hint: 'Wird automatisch aus der Konfiguration der Installation gesetzt.',
      auto: 'ai',
    },
    {
      key: 'ki-aus',
      label: 'Die KI-Funktion der Installation ist nicht eingerichtet',
      auto: 'ai-off',
    },
  ],
};

// ---------------------------------------------------------------------------
// Template 04a — privacy notice for **one** form
// ---------------------------------------------------------------------------

/**
 * The form-specific addendum to template 04
 * (`docs/legal/README.md` 5.2, ADR-0028 no. 4).
 *
 * **Why it exists at all.** Art. 13 Abs. 1 lit. c demands purpose and legal
 * basis **per processing operation**, and a form is a processing operation: a
 * notification of a death and a conference registration of the same
 * organisation have different ones. A single organisation text that is meant
 * to cover both becomes either incorrect or unreadable.
 *
 * **Why it is so short.** It is an *addendum* and not a second policy. Who is
 * responsible, which rights one has, which supervisory authority one turns to
 * and what the software technically does — all of that stands in the
 * organisation's privacy notice, once and for all of its forms. Repeating it
 * here would mean having to keep the same statement true per form; the last
 * paragraph links to it instead.
 *
 * **Its `fixed` part carries exactly one section, and nobody writes it**
 * (ADR-0028 no. 5). The fixed part of template 04 describes the behaviour of
 * *the software*, which is the same text for every form and therefore stands
 * where it stands, once. What stands here is narrower: the behaviour of
 * **this** form, as far as the application knows it without asking — today
 * that is the redirect after submitting, and its target is one setting of this
 * one form. It is `fixed` and not part of the body for the same reason
 * template 04's is: an organisation that could edit it could claim something
 * untrue about a redirect it does not control from here. That it is thereby
 * out of reach of `legalPageStatus` — which resolves `body` and never
 * `fixed` — is the second half of the same decision: a derived value must not
 * be able to colour a traffic light.
 */
const FORM_PRIVACY_FIXED = `⟪WENN:weiterleitung⟫
### Weiterleitung nach dem Absenden

Nach dem Absenden werden Sie auf [[APP_ZIELADRESSE_DER_WEITERLEITUNG]] weitergeleitet. Damit wird Ihre IP-Adresse an den Betreiber dieser Seite übertragen. Welche Daten dort verarbeitet werden, bestimmt dessen Datenschutzerklärung; die Formularadresse selbst wird nicht mit übertragen.
⟪ENDE⟫`;

const FORM_PRIVACY: LegalTemplate = {
  key: 'form:privacy',
  title: 'Datenschutzhinweise zu diesem Formular',
  purpose:
    'Zweck, Rechtsgrundlage und Aufbewahrung genau dieses Formulars. Art. 13 Abs. 1 lit. c DSGVO verlangt sie je Verarbeitung, und ein Formular ist eine Verarbeitung — die allgemeinen Hinweise der Organisation können sie nicht für alle Formulare zugleich richtig nennen. Der Text erscheint beim Ausfüllen, auf der Bestätigungsseite, beim Bearbeiten einer Antwort und im fortgesetzten Entwurf — jeweils über dem Weg zu den allgemeinen Hinweisen der Organisation.',
  body: `### Wofür dieses Formular Ihre Angaben erhebt

[[ZWECK]]

**Rechtsgrundlage:** [[RECHTSGRUNDLAGE]]

**Wie lange die Angaben aufbewahrt werden:** [[AUFBEWAHRUNG]]

⟪WENN:pflichtangaben⟫
**Pflichtangaben:** [[PFLICHTANGABEN]]
⟪ENDE⟫

⟪WENN:empfaenger⟫
**Empfänger dieser Angaben:** [[EMPFAENGER]]
⟪ENDE⟫

⟪WENN:besondere-kategorien⟫
**Besondere Kategorien nach Art. 9 DSGVO:** [[BESONDERE_KATEGORIEN]]
⟪ENDE⟫

Wer für diese Verarbeitung verantwortlich ist, welche Rechte Sie haben und wie Sie sie ausüben, steht in den [Datenschutzhinweisen von [[APP_NAME_DER_ORGANISATION]]]([[APP_ADRESSE_ORG_DATENSCHUTZ]]).`,
  fixed: FORM_PRIVACY_FIXED,
  emptyBody: `**Für dieses Formular ist kein eigener Datenschutzhinweis hinterlegt.**

Auf den öffentlichen Seiten dieses Formulars erscheint dann kein zusätzlicher Abschnitt; es gelten allein die [allgemeinen Datenschutzhinweise von [[APP_NAME_DER_ORGANISATION]]]([[APP_ADRESSE_ORG_DATENSCHUTZ]]). Das ist genau dann richtig, wenn dort Zweck, Rechtsgrundlage und Aufbewahrung **dieses** Formulars bereits stehen — und sonst nicht.`,
  slots: [
    {
      key: 'ZWECK',
      label: 'Zweck dieses Formulars',
      hint: '„Verwaltung" ist kein Zweck. Ein Zweck ist „Anmeldung zur Jahrestagung 2026 und deren Durchführung einschließlich Teilnehmerliste und Verpflegungsplanung".',
      example:
        'Anmeldung zur Jahrestagung 2026 und deren Durchführung einschließlich Teilnehmerliste und Verpflegungsplanung.',
      multiline: true,
    },
    {
      key: 'RECHTSGRUNDLAGE',
      label: 'Rechtsgrundlage',
      hint: 'Genau eine je Zweck, nicht mehrere vorsorglich — etwa Art. 6 Abs. 1 lit. b DSGVO (Vertrag), lit. c (rechtliche Verpflichtung), lit. e (öffentliche Aufgabe) oder lit. f (berechtigtes Interesse, dann mit dem Interesse).',
      example:
        'Art. 6 Abs. 1 lit. b DSGVO — die Angaben sind zur Durchführung Ihrer Anmeldung erforderlich.',
      multiline: true,
    },
    {
      key: 'AUFBEWAHRUNG',
      label: 'Aufbewahrungsdauer oder die Kriterien dafür',
      hint: 'Art. 13 Abs. 2 lit. a verlangt die Dauer oder die Kriterien für ihre Festlegung. „So lange wie nötig" ist kein Kriterium. Die Software löscht Antworten nicht von selbst — die Frist hält die Organisation ein, indem sie sie löscht.',
      example: 'Gelöscht drei Monate nach dem Ende der Tagung.',
      multiline: true,
    },
    {
      key: 'PFLICHTANGABEN',
      label: 'Pflichtangaben dieses Formulars und die Folge ihres Fehlens',
      hint: 'Welche Felder Pflicht sind, worauf sich die Pflicht stützt (Vertrag, Gesetz, Satzung) und was geschieht, wenn jemand sie nicht macht — Art. 13 Abs. 2 lit. e.',
      example:
        'Name und E-Mail-Adresse sind erforderlich; ohne sie kann die Anmeldung nicht bearbeitet werden. Alle übrigen Angaben sind freiwillig.',
      multiline: true,
    },
    {
      key: 'EMPFAENGER',
      label: 'Empfänger, die nur dieses Formular betreffen',
      hint: 'Nur die zusätzlichen: die Tagungsstätte, ein Reisebüro, eine Versicherung, andere Teilnehmende bei einer öffentlichen Teilnehmerliste. Wer für alle Formulare gilt, steht in den allgemeinen Hinweisen.',
      example: 'Tagungshaus Musterberg gGmbH — Zimmer- und Verpflegungsplanung',
      multiline: true,
    },
    {
      key: 'BESONDERE_KATEGORIEN',
      label: 'Besondere Kategorien nach Art. 9 DSGVO in diesem Formular',
      hint: 'Welche Angabe, welche Kategorie, welche Grundlage nach Art. 9 Abs. 2 und welcher Zweck. „Verpflegung: vegetarisch/vegan/halal/koscher" als Pflichtfeld ist eine Erhebung religiöser Daten — sie lässt sich fast immer durch ein freiwilliges Freitextfeld vermeiden.',
      example:
        'Angaben zu Unverträglichkeiten sind Gesundheitsdaten. Sie sind freiwillig, dienen allein der Verpflegungsplanung und beruhen auf Ihrer Einwilligung nach Art. 9 Abs. 2 lit. a DSGVO.',
      multiline: true,
    },
  ],
  conditions: [
    {
      key: 'pflichtangaben',
      label: 'Dieses Formular hat Pflichtfelder',
    },
    {
      key: 'empfaenger',
      label:
        'Die Angaben dieses Formulars gehen an Empfänger, die die allgemeinen Hinweise nicht nennen',
    },
    {
      key: 'besondere-kategorien',
      label: 'Dieses Formular erhebt besondere Kategorien nach Art. 9 DSGVO',
      hint: 'Verpflegungswünsche, Assistenzbedarf und Gesundheitsangaben gehören fast immer dazu, auch wenn sie nicht danach aussehen.',
    },
    {
      key: 'weiterleitung',
      label: 'Dieses Formular leitet nach dem Absenden weiter',
      hint: 'Wird aus den Einstellungen dieses Formulars gesetzt; die Zieladresse trägt die Anwendung selbst ein.',
      auto: 'redirect',
    },
  ],
};

// ---------------------------------------------------------------------------
// The registers
// ---------------------------------------------------------------------------

export const SYSTEM_LEGAL_TEMPLATES: Readonly<
  Record<SystemLegalPage, LegalTemplate>
> = {
  imprint: SYSTEM_IMPRINT,
  privacy: SYSTEM_PRIVACY,
};

export const TENANT_LEGAL_TEMPLATES: Readonly<
  Record<TenantLegalPage, LegalTemplate>
> = {
  imprint: TENANT_IMPRINT,
  privacy: TENANT_PRIVACY,
};

/**
 * The template of the form-specific privacy notice — **one**, not a register.
 *
 * A form has exactly one legal text page and no selection of them; a `Record`
 * with one key would be an enumeration that enumerates nothing.
 */
export const FORM_PRIVACY_TEMPLATE: LegalTemplate = FORM_PRIVACY;

/**
 * The placeholder in the installation's imprint from which the **name of the
 * operator** comes everywhere else.
 *
 * Named at one place, because three pages read it — the footer, every
 * organisation's provider details and their privacy notice — and a typed key
 * at three places would be the beginning of a divergence.
 */
export const OPERATOR_NAME_SLOT = 'NAME_DES_BETREIBERS';
