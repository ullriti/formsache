# Vorlage 03 — Datenschutzerklärung des Betreibers

> **Wer füllt das aus:** der Betreiber der Installation.
> **Wo erscheint es:** unter `/privacy`, verlinkt aus der Fußzeile jeder
> Seite.
> **Rechtsgrundlage:** Art. 12–14 DSGVO.
> **Was sie abdeckt:** die Verarbeitungen, bei denen der Betreiber selbst
> Verantwortlicher ist — Auslieferung der Anwendung, Betriebssicherheit,
> Sicherungen, Konten der Bearbeitenden, Mailversand als solcher, KI-Funktion.
> **Was sie *nicht* abdeckt:** die Inhalte der Formulare. Dafür ist die
> jeweilige Organisation verantwortlich → [Vorlage 04](04-datenschutzhinweise-organisation.md).
>
> ⚠️ **Diese Vorlage ist gegen den Quelltext geschrieben, nicht generisch.**
> Jede Tatsachenaussage steht in `docs/legal/README.md`, Abschnitt 6, mit
> Beleg. **Wer die Software ändert, prüft diesen Text mit.** Besonders:
> ein zusätzlicher Dienst von einem Dritten (Reichweitenmessung, Karte,
> Schriften-CDN, eingebettetes Video) macht Abschnitt 3 dieser Erklärung
> unwahr.

---

# Datenschutzerklärung

**Stand:** [[DATUM]]

## 1. Wer für diese Anwendung verantwortlich ist

Verantwortlich im Sinne der Datenschutz-Grundverordnung für den **Betrieb**
dieser Anwendung ist:

[[NAME_DES_BETREIBERS]]
[[STRASSE_UND_HAUSNUMMER]]
[[PLZ]] [[ORT]]
E-Mail: [[E_MAIL_FUER_DATENSCHUTZANFRAGEN]]
Telefon: [[TELEFONNUMMER]]

⟪NUR WENN EIN DATENSCHUTZBEAUFTRAGTER BESTELLT IST⟫
**Datenschutzbeauftragte Person:**
[[NAME]]
[[KONTAKTWEG]]
⟪ENDE⟫
⟪NUR WENN KEINER BESTELLT IST⟫
Eine Datenschutzbeauftragte oder ein Datenschutzbeauftragter ist **nicht
bestellt**; die gesetzlichen Voraussetzungen dafür liegen nicht vor.

> ⚠️ Diese Aussage ist zu prüfen, nicht zu übernehmen. Die Bestellpflicht folgt
> aus Art. 37 DSGVO und § 38 BDSG — bei öffentlichen Stellen praktisch immer,
> bei nicht-öffentlichen Stellen ab zwanzig ständig mit automatisierter
> Verarbeitung beschäftigten Personen oder bei umfangreicher Verarbeitung
> besonderer Kategorien.
⟪ENDE⟫

## 2. Was diese Anwendung ist — und wer wofür verantwortlich ist

Unter dieser Adresse wird eine Formular- und Umfrageplattform betrieben. Über
sie stellen **mehrere eigenständige Organisationen** eigene Formulare bereit.

Daraus folgt eine Aufteilung, die Sie kennen sollten, weil sie bestimmt, an wen
Sie sich wenden:

| Worum es geht | Wer ist verantwortlich | Wo steht die Information |
|---|---|---|
| Die **Inhalte** eines Formulars: welche Fragen gestellt werden, wofür die Antworten verwendet werden, wie lange sie aufbewahrt werden | die Organisation, die das Formular anbietet | in den Datenschutzhinweisen dieser Organisation, verlinkt in der Fußzeile des Formulars |
| Der **technische Betrieb**: Auslieferung der Seiten, Schutz vor Überlastung und Missbrauch, Datensicherung, Überwachung | [[NAME_DES_BETREIBERS]] | in dieser Erklärung |
| Die **Konten der Bearbeitenden** | [[NAME_DES_BETREIBERS]] und die jeweilige Organisation gemeinsam | Abschnitt 5 |

Für die Antworten, die Sie in ein Formular eintragen, verarbeitet
[[NAME_DES_BETREIBERS]] **im Auftrag** der jeweiligen Organisation
(Art. 28 DSGVO) — nicht für eigene Zwecke. Mit jeder Organisation besteht dazu
ein Auftragsverarbeitungsvertrag.

## 3. Was beim bloßen Aufrufen einer Seite geschieht

**Diese Anwendung setzt beim Ausfüllen eines Formulars keine Cookies, speichert
nichts in Ihrem Browser und lädt keine Inhalte von Dritten.**

Das ist keine Absichtserklärung, sondern der geprüfte Zustand der Software:

- **Keine Cookies auf den öffentlichen Seiten.** Ein Cookie wird ausschließlich
  gesetzt, wenn sich eine Person an dieser Anwendung **anmeldet** — siehe
  Abschnitt 5.
- **Keine Speicherung in Ihrem Browser.** Weder `localStorage` noch
  `sessionStorage` werden verwendet. Auch das Kennwort eines
  kennwortgeschützten Formulars wird nach der Eingabe **nicht** im Browser
  abgelegt.
- **Keine Inhalte von Dritten.** Schriftarten, Bilder, Skripte und Formatvorlagen
  werden ausschließlich von diesem Server ausgeliefert. Es gibt kein
  Schriften-Netzwerk, keine Karten, keine eingebetteten Videos, keine
  Schaltflächen sozialer Netzwerke.
- **Keine Reichweitenmessung, keine Analyse, kein Tracking, kein Profiling und
  keine automatisierte Entscheidungsfindung** im Sinne des Art. 22 DSGVO.

Weil damit weder Informationen in Ihrer Endeinrichtung gespeichert noch aus ihr
ausgelesen werden, **braucht diese Anwendung keine Einwilligung nach § 25
TDDDG** und zeigt deshalb auch keinen Cookie-Hinweis. Ein solcher Hinweis wäre
hier eine Behauptung über etwas, das nicht stattfindet.

### 3.1 Ihre IP-Adresse

Damit Ihr Browser eine Antwort erhält, muss der Server Ihre IP-Adresse
verarbeiten. Darüber hinaus wird sie ausschließlich verwendet, um die Anwendung
gegen Überlastung und automatisierten Missbrauch zu schützen (Zählung der
Anfragen je Adresse).

- Die Adresse wird dafür **nur im Arbeitsspeicher** gehalten, nicht in der
  Datenbank gespeichert.
- Sie wird nach Ablauf des jeweiligen Zeitfensters verworfen: **längstens zwei
  Minuten** bei Formularaufrufen, Absendungen und Kennworteingaben, **längstens
  eine Stunde** bei Datei-Uploads.
- Bei IPv6 wird nur der Netzanteil (`/64`) verwendet, nicht die vollständige
  Adresse.
- **Die Protokolldateien der Anwendung enthalten keine IP-Adressen** und keine
  Formularinhalte. Sie enthalten Fehlercodes, Bezeichner von Programmteilen und
  eine zufällige Anfrage-Kennung; ein automatisierter Test hält das fest.

**Rechtsgrundlage:** Art. 6 Abs. 1 lit. f DSGVO. Berechtigtes Interesse ist der
sichere und verfügbare Betrieb der Anwendung — dasselbe Interesse, das
Art. 32 DSGVO zur Pflicht macht.

⚠️ **Nicht erfasst sind Protokolle, die dem eigentlichen Server vorgelagert
sind.** Vor dieser Anwendung steht ein Zugangsserver (Reverse-Proxy), der die
Verschlüsselung übernimmt. Ob und wie lange er Zugriffe protokolliert,
entscheidet [[NAME_DES_BETREIBERS]]:
[[AUSSAGE_ZUM_ZUGANGSSERVER — z. B. „Zugriffsprotokolle werden dort für 7 Tage
aufbewahrt und danach automatisch gelöscht" ODER „Der Zugangsserver
protokolliert keine IP-Adressen"]].

## 4. Was beim Ausfüllen eines Formulars geschieht

Die **Inhalte** Ihrer Antworten verarbeitet [[NAME_DES_BETREIBERS]] nur im
Auftrag der Organisation, die das Formular anbietet. Über Zweck, Rechtsgrundlage
und Aufbewahrung entscheidet **sie**; ihre Datenschutzhinweise sind in der
Fußzeile des Formulars verlinkt.

Was [[NAME_DES_BETREIBERS]] beisteuert, ist die technische Ausführung. Wie sie
im Einzelnen aussieht — welche Daten wo liegen, wer sie sehen kann und nach
welchen Fristen sie gelöscht werden — steht in Abschnitt B von
[[ADRESSE_DER_DATENSCHUTZHINWEISE — je Organisation]] und gilt für jede
Organisation dieser Installation gleichermaßen.

## 5. Konten der Bearbeitenden

Dieser Abschnitt betrifft **nur** Personen mit einem Zugang zu dieser Anwendung.
Wer lediglich ein Formular ausfüllt, hat kein Konto und ist hiervon nicht
betroffen.

**Gemeinsame Verantwortlichkeit (Art. 26 DSGVO).** [[NAME_DES_BETREIBERS]] und
die jeweilige Organisation entscheiden hier gemeinsam: die Organisation
darüber, wen sie einlädt und welche Rechte sie vergibt;
[[NAME_DES_BETREIBERS]] über das Anmeldeverfahren, die Sitzungsdauer und den
Versand der Kontomails. Das Wesentliche der dazu geschlossenen Vereinbarung:
[[VERWEIS_AUF_DIE_VEREINBARUNG_ODER_KURZFASSUNG]]. Ihre Rechte nach der DSGVO
können Sie gegenüber **jedem** der beiden geltend machen (Art. 26 Abs. 3);
zentrale Anlaufstelle ist [[ANLAUFSTELLE]].

| Was | Wozu | Wie lange |
|---|---|---|
| Name, E-Mail-Adresse | Anmeldung, Zuordnung von Bearbeitungen, Kontomails | mit dem Konto |
| Kennwort als Argon2id-Prüfwert **oder** die Kennung eines externen Anmeldedienstes | Anmeldung | mit dem Konto |
| Gruppen- und Formularrechte, Zeitpunkt der letzten Anmeldung | Rechteprüfung | mit dem Konto |
| Sitzungen (Zeitpunkte, zuletzt gewählte Organisation) | angemeldet bleiben | abgelaufene oder abgemeldete Sitzungen werden nach **7 Tagen** physisch gelöscht |
| Links zum Zurücksetzen des Kennworts und Einladungslinks | Erstzugang, Kennwortwechsel | nach Ablauf oder Einlösung **7 Tage**, dann physisch gelöscht |

**Zwei Cookies**, beide für den angemeldeten Betrieb unbedingt erforderlich und
deshalb ohne Einwilligung zulässig (§ 25 Abs. 2 Nr. 2 TDDDG):

| Cookie | Zweck | Eigenschaften | Lebensdauer |
|---|---|---|---|
| Sitzungs-Cookie | hält die Anmeldung | `HttpOnly`, `SameSite=Lax`, im Betrieb `Secure` | bis zum Abmelden, längstens [[SESSION_TTL_HOURS]] Stunden |
| CSRF-Token-Cookie | schützt vor Anfragen, die eine fremde Seite in Ihrem Namen stellt | für die Anwendung lesbar (das ist seine Aufgabe), authentifiziert nichts | wie die Sitzung |

Ein Konto wird **nicht** durch Selbstregistrierung angelegt, sondern nur durch
eine Einladung. Die Einladungsmail geht über den Mailserver von
[[NAME_DES_BETREIBERS]] hinaus; ihr Wortlaut ist fest und von keiner
Organisation änderbar.

⟪NUR WENN EINE ORGANISATION SSO NUTZT⟫
**Anmeldung über einen externen Anmeldedienst (SSO).** Nutzt eine Organisation
ihren eigenen Identitätsanbieter, erfährt dieser, dass und wann eine Anmeldung
stattgefunden hat. Welche Daten er dabei verarbeitet, bestimmt die Organisation
und nicht [[NAME_DES_BETREIBERS]].
⟪ENDE⟫

**Rechtsgrundlage:** Art. 6 Abs. 1 lit. b DSGVO (Durchführung des
Nutzungsverhältnisses) bzw. Art. 6 Abs. 1 lit. e i. V. m. [[LANDESRECHT]] bei
öffentlichen Stellen.

## 6. E-Mail-Versand

Diese Anwendung versendet E-Mails: Bestätigungen an Ausfüllende,
Benachrichtigungen an Bearbeitende, Kontomails, Betriebsalarme.

- Der Versand läuft über [[BEZEICHNUNG_DES_MAILSERVERS_ODER_DIENSTLEISTERS]].
  ⟪NUR WENN EIN EXTERNER DIENSTLEISTER GENUTZT WIRD⟫Mit diesem Anbieter besteht
  ein Auftragsverarbeitungsvertrag nach Art. 28 DSGVO.⟪ENDE⟫
  ⚠️ Organisationen können einen **eigenen** Mailserver eintragen. Tun sie das,
  läuft ihr Versand über diesen, und die Verantwortung dafür liegt bei ihnen.
- Zum Nachweis der Zustellung führt die Anwendung ein **Versandprotokoll**:
  Empfängeradresse, Betreff, der gerenderte Text der Nachricht, Status und
  Versuchszeitpunkte. **Der Text kann Formularinhalte enthalten** — deshalb wird
  jede Protokollzeile nach **90 Tagen** physisch gelöscht. Wird eine Antwort
  endgültig gelöscht, werden die personenbezogenen Spalten der zugehörigen
  Protokollzeilen sofort geleert.
- **Anlagen zu Antworten werden nicht per E-Mail versendet.**

⚠️ **Eine bereits versendete E-Mail liegt im Postfach ihres Empfängers.** Sie
lässt sich durch eine Löschung in dieser Anwendung nicht zurückholen.

## 7. Datensicherung

Datenbank und Dateiablage werden regelmäßig gesichert; die Sicherungen sind
verschlüsselt und werden [[BACKUP_KEEP_DAYS]] Tage aufbewahrt, danach gelöscht.
Aufbewahrungsort: [[ORT_DER_SICHERUNGEN]].

⚠️ **Was eine Löschung nicht erreicht.** Wird ein Datensatz in dieser Anwendung
endgültig gelöscht, verschwindet er aus dem laufenden Betrieb. In bereits
erstellten Sicherungen bleibt er bis zum Ablauf der Aufbewahrungsfrist
enthalten. Wird eine Sicherung eingespielt, wird die Löschung an dem
wiederhergestellten Bestand erneut vorgenommen.

**Rechtsgrundlage:** Art. 6 Abs. 1 lit. f i. V. m. Art. 32 Abs. 1 lit. c DSGVO.

## 8. Betriebsüberwachung

Die Anwendung führt über ihre Hintergrundläufe (Mailversand, Löschläufe)
Buch — je Lauf eine Zeile mit Zeitpunkt, Ergebnis und Anzahl. **Diese Zeilen
benennen keine Personen.** Bleiben Läufe aus oder häufen sich Fehler, geht ein
Alarm an [[ALARM_ADRESSE]].

## 9. Empfänger und Auftragsverarbeiter

| Empfänger | Wofür | Ort |
|---|---|---|
| [[NAME_DES_HOSTERS]] | Bereitstellung der Server | [[ORT_DES_RECHENZENTRUMS]] |
| [[NAME_DES_MAILDIENSTLEISTERS]] | Versand der E-Mails | [[ORT]] |
| ⟪NUR WENN ZUTREFFEND⟫[[WEITERE_DIENSTLEISTER]]⟪ENDE⟫ | [[ZWECK]] | [[ORT]] |

Mit allen genannten Stellen bestehen Verträge zur Auftragsverarbeitung nach
Art. 28 DSGVO.

**Eine Übermittlung an Behörden** erfolgt nur, soweit eine gesetzliche
Verpflichtung besteht. Eine Weitergabe zu Werbezwecken oder ein Verkauf von
Daten findet nicht statt.

**Zwischen den Organisationen dieser Installation werden keine Daten
ausgetauscht.** Die Trennung wird serverseitig durchgesetzt: jede fachliche
Datenbankabfrage trägt die Kennung der Organisation als Bedingung, und
automatisierte Tests belegen, dass ein Zugriff über die Grenze scheitert.

## 10. Drittlandübermittlung

⟪NUR WENN DIE KI-FUNKTION AUS IST — DAS IST DER AUSLIEFERUNGSZUSTAND⟫
**Es findet keine Übermittlung in ein Drittland außerhalb der EU/des EWR
statt.** Server, Datenbank, Dateiablage und Sicherungen liegen in
[[LAND_bzw_REGION]].
⟪ENDE⟫

⟪NUR WENN DIE KI-FUNKTION EIN IST UND EIN ANBIETER AUSSERHALB DER EU VERARBEITET⟫
Für die in Abschnitt 11 beschriebene KI-Funktion werden Daten an
[[NAME_DES_KI_ANBIETERS]] mit Sitz in [[LAND]] übermittelt. Grundlage der
Übermittlung ist
[[ANGEMESSENHEITSBESCHLUSS_EU_US_DATA_PRIVACY_FRAMEWORK_ODER_STANDARDVERTRAGSKLAUSELN_ART_46_ABS_2_LIT_C]].
⟪NUR WENN STANDARDVERTRAGSKLAUSELN⟫Ergänzend wurde eine
Übermittlungs-Folgenabschätzung durchgeführt und folgende zusätzliche Maßnahmen
getroffen: [[MASSNAHMEN]].⟪ENDE⟫
Eine Kopie der Garantien kann unter [[KONTAKT]] angefordert werden.

> ⚠️ **Vor dem Einschalten prüfen und hier eintragen** — nicht danach. Ob ein
> Anbieter unter einem Angemessenheitsbeschluss zertifiziert ist, ändert sich;
> die geltende Liste ist maßgeblich, nicht die Angabe des Anbieters auf seiner
> eigenen Seite.
⟪ENDE⟫

## 11. KI-gestützte Formularerstellung

⟪NUR WENN DIE FUNKTION AUS IST — AUSLIEFERUNGSZUSTAND⟫
Diese Installation nutzt **keine** KI-Funktion. Sie ist abgeschaltet; ohne
hinterlegten Zugangsschlüssel ist sie in der Anwendung nicht vorhanden.
⟪ENDE⟫

⟪NUR WENN DIE FUNKTION EIN IST⟫
Bearbeitende können sich einen **Formularentwurf** aus einem selbst getippten
Text erzeugen lassen.

⚠️ **Wichtig für Ausfüllende:** Von dieser Funktion sind **keine Antwortdaten,
keine Teilnehmerdaten und keine Organisationsdaten** betroffen. Verarbeitet wird
ausschließlich der Text, den eine bearbeitende Person selbst eingibt, um ein
Formular zu entwerfen. Automatisierte Tests belegen, dass nichts anderes die
Anwendung verlässt.

| | |
|---|---|
| **Anbieter** | [[NAME_DES_KI_ANBIETERS]], Modell [[MODELL]] |
| **Verarbeitungsregion** | [[EU_ODER_GLOBAL_ODER_US]] |
| **Was hinausgeht** | der eingegebene Text, eine Sprachkennung sowie technische Angaben, die jeder HTTP-Aufruf mitführt (Kennung und Version der verwendeten Programmbibliothek). Angaben zum Rechner (Betriebssystem, Prozessorarchitektur, Laufzeitversion) werden ausdrücklich unterdrückt. |
| **Was nicht hinausgeht** | Antworten, Anlagen, Namen und Adressen von Teilnehmenden, Angaben zur Organisation |
| **Rechtsgrundlage** | Art. 6 Abs. 1 lit. f DSGVO — berechtigtes Interesse an einer effizienten Formularerstellung |
| **Aufbewahrung bei uns** | der eingegebene Text **30 Tage**, dann physisch gelöscht; die Zuordnung der Nutzungszeile zu einer Person nach **12 Monaten** entfernt; danach bleibt eine anonyme Verbrauchszeile (Organisation, Monat, Modell, Menge) ohne Personenbezug |
| **Aufbewahrung beim Anbieter** | richtet sich nach dem Auftragsverarbeitungsvertrag mit ihm: [[ANGABE]] |

Mit [[NAME_DES_KI_ANBIETERS]] besteht ein Auftragsverarbeitungsvertrag nach
Art. 28 DSGVO.

⚠️ **Hinweis an Bearbeitende, der hierher gehört, weil er die Aussage oben
trägt:** In das Eingabefeld gehören **keine** personenbezogenen Daten. Wer einen
Namen hineinschreibt, übermittelt ihn an den Anbieter — und die Zusage „es
gehen keine Personendaten hinaus" gilt für die Software, nicht für das, was
jemand hineintippt.
⟪ENDE⟫

## 12. Ihre Rechte

Sie haben gegenüber der jeweils verantwortlichen Stelle das Recht auf

- **Auskunft** über die zu Ihnen verarbeiteten Daten (Art. 15),
- **Berichtigung** unrichtiger Daten (Art. 16),
- **Löschung** (Art. 17),
- **Einschränkung der Verarbeitung** (Art. 18),
- **Datenübertragbarkeit**, soweit die Verarbeitung auf Einwilligung oder
  Vertrag beruht und automatisiert erfolgt (Art. 20),
- **Widerspruch** gegen eine Verarbeitung, die auf ein berechtigtes Interesse
  gestützt ist (Art. 21),
- **Widerruf einer Einwilligung** mit Wirkung für die Zukunft (Art. 7 Abs. 3).

**Wohin Sie sich wenden:**

- Geht es um die **Inhalte eines Formulars** — Ihre Antworten, Ihre Anlagen,
  eine Bestätigungsmail: an die Organisation, die das Formular anbietet. Sie
  steht in der Fußzeile des Formulars.
- Geht es um den **Betrieb** — Ihr Konto, Protokolle, Sicherungen: an
  [[NAME_DES_BETREIBERS]] unter [[E_MAIL_FUER_DATENSCHUTZANFRAGEN]].
- Im Zweifel genügt eine Anfrage an [[E_MAIL_FUER_DATENSCHUTZANFRAGEN]]; sie
  wird weitergeleitet.

⚠️ **Was eine Auskunft erschwert, und warum wir es sagen:** Ausfüllende haben
**kein Konto**. Es gibt daher keine Abfrage „alle Daten zu Person X". Bitte
nennen Sie in einem Auskunfts- oder Löschersuchen das **Formular** und
möglichst den **ungefähren Zeitpunkt** — sonst lässt sich Ihre Eingabe nicht
auffinden.

**Beschwerderecht.** Sie können sich bei einer Datenschutz-Aufsichtsbehörde
beschweren, insbesondere bei der des Bundeslandes Ihres gewöhnlichen
Aufenthalts oder bei der für [[NAME_DES_BETREIBERS]] zuständigen:
[[NAME_UND_ANSCHRIFT_DER_AUFSICHTSBEHOERDE]].

## 13. Änderungen dieser Erklärung

Diese Erklärung wird angepasst, wenn sich die Verarbeitung ändert — etwa wenn
die KI-Funktion eingeschaltet oder ein Dienstleister gewechselt wird. Es gilt
jeweils die hier abrufbare Fassung; der Stand steht oben.

---

## Anhang für den Betreiber — nicht veröffentlichen

**Prüfliste vor der Veröffentlichung:**

- [ ] Alle `[[…]]` ersetzt, alle `⟪…⟫` entweder aufgelöst oder ganz entfernt
- [ ] Abschnitt 3 **gemessen**, nicht geglaubt: Browser öffnen, Netzwerkreiter,
      ein Formular ausfüllen und absenden; die Liste der Gegenstellen muss leer
      sein außer dem eigenen Server
- [ ] Abschnitt 3.1 gegen die eigene Reverse-Proxy-Konfiguration abgeglichen
      (`TRUST_PROXY_HOPS`, Zugriffsprotokolle des Proxys)
- [ ] Abschnitt 7: `BACKUP_KEEP_DAYS` aus der `.env` eingesetzt
- [ ] Abschnitt 5: `SESSION_TTL_HOURS` eingesetzt
- [ ] Abschnitt 9: AV-Verträge mit **allen** genannten Stellen liegen vor
- [ ] Abschnitt 10/11: nur ausgefüllt, wenn die KI tatsächlich eingeschaltet
      ist — und dann **vor** dem Setzen des Schlüssels
- [ ] Abschnitt 12: Aufsichtsbehörde geprüft (bei kirchlichen Trägern:
      Datenschutzaufsicht der EKD bzw. der katholischen Kirche, nicht die
      staatliche)

**Was diese Erklärung bewusst nicht enthält:**

| Weggelassen | Warum |
|---|---|
| Cookie-Tabelle mit Einwilligungskategorien | Es gibt keine einwilligungspflichtigen Cookies. Eine Kategorientabelle würde welche suggerieren. |
| „Wir verwenden Google Analytics / Matomo / …" | Wird nicht verwendet. Wer es nachrüstet, schreibt es hinein — und braucht dann eine Einwilligungslösung nach § 25 TDDDG. |
| Abschnitt „Server-Logfiles" mit den üblichen sieben Feldern | Die Anwendung protokolliert keine IP-Adressen und keine User-Agents. Die Standardaufzählung wäre unrichtig. Was der vorgelagerte Proxy tut, steht in 3.1 — und zwar als Frage an den Betreiber, nicht als Behauptung. |
| „Soziale Netzwerke", „Newsletter", „Bewerbungen" | Findet hier nicht statt. |
