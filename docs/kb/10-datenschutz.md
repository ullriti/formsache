# Datenschutz — Verzeichnis, Löschkonzept, Maßnahmen

- [1. Verzeichnis der Verarbeitungstätigkeiten](#1-verzeichnis-der-verarbeitungstätigkeiten)
- [2. Löschkonzept](#2-löschkonzept)
- [3. Technische und organisatorische Maßnahmen](#3-technische-und-organisatorische-maßnahmen)
- [4. Die Einschaltbedingung der KI](#4-die-einschaltbedingung-der-ki)

Jede neue Datenart, jede neue Frist und jede neue Empfängerbeziehung wird hier
eingetragen, **bevor** sie in Betrieb geht. Die Handgriffe für eine
Betroffenenanfrage stehen in [`09-betrieb.md`](09-betrieb.md).

⚠️ **Was hier steht, ist die Sicht der Anwendung.** Der Text eines
Verarbeitungsverzeichnisses nach Art. 30 DSGVO ist **Betreiberpflicht**: der
Betreiber ist Verantwortlicher, nicht diese Software. Was nur er weiß, steht
unten als benanntes Feld mit Platzhalter — ein leeres Feld mit Namen fällt bei
der ersten Prüfung auf, eine fehlende Zeile nicht.

## 1. Verzeichnis der Verarbeitungstätigkeiten

### 1.1 Die Felder, die nur der Betreiber ausfüllen kann

| Feld | Inhalt | Wer trägt ihn ein |
|---|---|---|
| **Verantwortlicher** (Name, Anschrift, Vertretung) | `⟨offen: Betreiber⟩` | Betreiber |
| **Kontaktdaten für Betroffenenanfragen** | `⟨offen: Betreiber⟩` | Betreiber |
| **Datenschutzbeauftragter** (falls bestellt; sonst ausdrücklich „nicht bestellt") | `⟨offen: Betreiber⟩` | Betreiber |
| **Rechtsgrundlagen je Datenkategorie** (Art. 6 Abs. 1) | `⟨offen: Betreiber bzw. sein Datenschutzbeauftragter⟩` | Betreiber |
| **Drittlandübermittlung** und ihre Grundlage | `⟨offen: Betreiber⟩` — heute **keine**, solange die KI aus ist (1.7) | Betreiber |
| **Auftragsverarbeiter und ihre AV-Verträge** (Hoster · SMTP-Betreiber · ggf. KI-Anbieter) | `⟨offen: Betreiber⟩` | Betreiber |
| **Löschfristen** | Abschnitt 2 | — |
| **Technische und organisatorische Maßnahmen** | Abschnitt 3 | — |

⚠️ **Der AV-Vertrag mit dem KI-Anbieter ist Vorbedingung, nicht Nacharbeit**
(ADR-0015 Nr. 13): er muss **vor** dem Hinterlegen eines Schlüssels vorliegen.
Die Anwendung kann das nicht prüfen — das Setzen des Schlüssels *ist* die
Erklärung des Betreibers, dass der Vertrag besteht.

### 1.2 Bearbeiter-Konten

Die einzigen Menschen mit einem Konto. **Teilnehmer haben keins.**

| Feld | Inhalt |
|---|---|
| **Zweck** | Anmeldung, Rechteprüfung, Zuordnung von Bearbeitungen zu einer Organisation |
| **Betroffene** | Bearbeiter und Administratoren der Organisationen und des Betreibers |
| **Datenkategorien** | Name, E-Mail-Adresse, Passwort-Hash (Argon2id) *oder* die Kennung eines externen Anmeldedienstes, Gruppen- und Formularrechte, Zeitpunkt der letzten Anmeldung |
| **Empfänger** | keine außerhalb der Installation. Bei OIDC-Anmeldung erfährt der Identitätsanbieter der Organisation, dass eine Anmeldung stattfand |
| **Drittland** | keins (Installation EU-gehostet) |
| **Löschfrist** | mit dem Konto; ein entferntes Konto lässt keine Personenreferenz zurück |

### 1.3 Antworten auf Formulare

| Feld | Inhalt |
|---|---|
| **Zweck** | Entgegennahme und Auswertung der Meldungen — Veranstaltungsanmeldung, Bestandsmeldung, Sterbefallmeldung |
| **Betroffene** | die ausfüllende Person; mittelbar jede Person, die sie in einem Freitextfeld nennt |
| **Datenkategorien** | **was die Organisation gefragt hat** — die Anwendung gibt keine Felder vor. Dazu technisch: Zeitpunkt, Formularfassung, Bearbeiten-Token |
| **Empfänger** | die berechtigten Bearbeiter **der eigenen Organisation**; der SMTP-Betreiber, soweit eine Benachrichtigung Antwortinhalte trägt; sonst niemand |
| **Drittland** | keins |
| **Löschfrist** | keine automatische — gelöscht wird durch die Organisation, dann Papierkorb 30 Tage (Abschnitt 2). Eine Anwendung kann nicht wissen, wann eine Anmeldung ihren Zweck erfüllt hat |

⚠️ **Die Datenminimierung liegt im Formular, nicht im Code.** Wer ein Feld in
den Builder zieht, entscheidet über eine Datenkategorie; ein neues, dauerhaft
verwendetes Pflichtfeld mit sensiblem Inhalt gehört hierher.

⚠️ **Und die Informationspflicht liegt je Formular** (ADR-0028 Nr. 4). Zweck und
Rechtsgrundlage sind nach Art. 13 Abs. 1 lit. c **je Verarbeitung** anzugeben,
und ein Formular ist eine Verarbeitung — eine Sterbefallmeldung und eine
Tagungsanmeldung derselben Organisation haben verschiedene. Dafür gibt es in
den Formular-Einstellungen (Recht: `can_manage_form_settings`) das Feld
*Datenschutzhinweise zu diesem Formular*; es erscheint auf jeder öffentlichen
Seite dieses Formulars über dem Weg zu den allgemeinen Hinweisen der
Organisation. Fehlt es, sagt der Dialog vor dem Veröffentlichen das — es gibt
bewusst **keinen** dauerhaften offenen Punkt dafür, weil eine Organisation mit
einer genügenden Gesamterklärung sonst eine Meldung sähe, die nichts benennt,
was zu beheben wäre.

### 1.4 Zwischengespeicherte Entwürfe

| Feld | Inhalt |
|---|---|
| **Zweck** | Ausfüllen unterbrechen und später fortsetzen, ohne Konto |
| **Betroffene** | die ausfüllende Person |
| **Datenkategorien** | die halb getippten Antworten samt Anlagen, Zeitpunkt, Ablaufzeitpunkt, Entwurfs-Token |
| **Empfänger** | **niemand** — ein Entwurf ist für Bearbeiter nicht sichtbar und ausschließlich über seine Adresse erreichbar |
| **Betroffenenrechte** | Auskunft und Löschung laufen deshalb nicht über die Oberfläche: [`09-betrieb.md`](09-betrieb.md) |
| **Drittland** | keins |
| **Löschfrist** | 30 Tage, oder mit der Frist des Formulars, wenn diese früher liegt |

### 1.5 Anlagen zu Antworten

| Feld | Inhalt |
|---|---|
| **Zweck** | Nachweise zu einer Meldung — Bescheinigung, Urkunde, Scan |
| **Betroffene** | die hochladende Person und jede Person, die im Dokument vorkommt |
| **Datenkategorien** | der Dateiinhalt (PDF, PNG, JPG — Positivliste, Abschnitt 3), Dateiname, Größe, Zeitpunkt |
| **Empfänger** | die berechtigten Bearbeiter der eigenen Organisation. Anlagen gehen **nicht** per Mail hinaus |
| **Drittland** | keins |
| **Löschfrist** | mit der Antwort; unbeansprucht 24 Stunden |
| **Datenminimierung** | Bildmetadaten werden beim Hochladen entfernt |

**Was entfernt wird:** bei JPEG der EXIF- und der XMP-Block (`APP1`) sowie der
Photoshop-/IPTC-Block (`APP13`), bei PNG die Chunks `eXIf`, `tEXt`, `zTXt` und
`iTXt` — ein Handyfoto trägt regelmäßig GPS-Koordinaten, Gerätemodell und
Seriennummer.

⚠️ **Was das nicht ist:** keine Inhaltsprüfung und kein Virenscanner
(ADR-0014); die Bilddaten laufen unverändert durch. **PDF bleibt unangetastet**
— seine Metadaten zu entfernen hieße, seine Struktur zu deuten. Ein Bild,
dessen Aufbau der Leser nicht versteht, geht unverändert durch.

### 1.6 Versandprotokoll (`mail_log`)

| Feld | Inhalt |
|---|---|
| **Zweck** | Betriebsnachweis des Mailversands: *ist die Bestätigung angekommen, und wenn nicht, warum* |
| **Betroffene** | die Empfänger der Benachrichtigungen |
| **Datenkategorien** | Empfängeradresse, Betreff, eingefrorener Rumpf, Status, Versuche, Zeitpunkte, absendende Identität. **Der Rumpf kann Antwortinhalte tragen** — das ist der Grund für die 90-Tage-Frist |
| **Empfänger** | Bearbeiter mit *Einstellungen verwalten* **und** *Antworten ansehen*; der SMTP-Betreiber beim Versand |
| **Drittland** | hängt am SMTP-Betreiber der Organisation — `⟨offen: Betreiber, je Organisation⟩` |
| **Löschfrist** | 90 Tage physisch; beim endgültigen Löschen einer Antwort sofort die personenbezogenen Spalten (`apps/api/src/mail-log/mail-log-erasure.ts`) |

### 1.7 KI-Nutzung

⚠️ **Zustand heute: aus.** Ohne hinterlegten Schlüssel ist die Funktion
abwesend — kein Menüeintrag, die Route antwortet 404. Es findet damit keine
Verarbeitung dieser Kategorie statt und es gibt keinen Empfänger. Der Eintrag
steht trotzdem vollständig hier, weil das Einschalten der Auslöser ist.

Anbieter, Modell, verschlüsselter Schlüssel und Region stehen als Einstellung
in der Datenbank. Die Region ist eine geschlossene Auswahl — `eu` · `global` ·
`us` — mit der Vorgabe `eu`.

| Feld | Inhalt |
|---|---|
| **Zweck** | Erzeugung eines Formularentwurfs aus einem Freitext |
| **Betroffene** | Bearbeiter mit dem Recht *Formulare bauen*; mittelbar jede Person, die ein Bearbeiter im Freitext nennt |
| **Datenkategorien** | der getippte Freitext, Sprachkennung, Zeitpunkt, auslösende Person, Organisation, Verbrauch |
| **Empfänger** | der hinterlegte Anbieter — **heute keiner**. Hinaus geht ausschließlich Freitext und Sprachkennung; **keine** Antwort-, Teilnehmer- oder Organisationsdaten (`apps/api/test/ai/payload-canaries.spec.ts`) |
| **Drittland** | **hängt an der Region.** `eu` hält die Verarbeitung beim EU-Endpunkt; `global` und `us` sind eine Drittlandübermittlung und brauchen ihre eigene Grundlage. Für Anthropic ist EU-Verarbeitung **nicht** zugesichert |
| **Löschfrist** | Freitext 30 Tage physisch · Personenbezug der Nutzungszeile nach 12 Monaten entfernt · der anonyme Zähler ohne Frist |

## 2. Löschkonzept

**„Physisch" heißt: aus der lebenden Zeile.** MVCC-Tupelversionen bis zum
`VACUUM`, WAL und Sicherungen sind davon nicht erfasst; das gilt für **jede**
Frist dieser Anwendung. Eine Sicherung altert mit ihrer eigenen
Aufbewahrungsfrist aus (`BACKUP_KEEP_DAYS`, ADR-0017).

### 2.1 Die Fristen

Die Zahlen sind geprüft, nicht abgeschrieben: `packages/shared/src/retention-doc.test.ts`
liest die exportierten Konstanten und diese Tabelle und vergleicht sie in
**beide** Richtungen.

| Population | Was verschwindet | Konstante | Frist | Begründung und Beleg |
|---|---|---|---|---|
| Papierkorb | Formular, Antwort oder Organisation samt Anlagen, Ereignis-Anmeldungen und Kindzeilen — physisch | `TRASH_RETENTION_DAYS` | 30 Tage | Umkehrbarkeit eines Versehens; `apps/api/src/trash/purge/retention-purge.service.ts`, Test `apps/api/test/trash/retention-purge.spec.ts` |
| Zwischengespeicherte Entwürfe | die Entwurfszeile samt ihrer Anlagen | `TRASH_RETENTION_DAYS` | 30 Tage | **dieselbe Zahl wie der Papierkorb und bewusst keine zweite**; `packages/shared/src/draft-retention.ts`, Test `apps/api/test/public/draft.spec.ts` |
| Unbeanspruchte Anlagen | Bytes und `file`-Zeile einer Datei, die keine Antwort beansprucht hat | `UNCLAIMED_FILE_LIFETIME_MS` | 24 Stunden | ein Wartezimmer ist kein Speicher (ADR-0014 Nr. 15); `apps/api/src/files/purge/file-purge.service.ts`, Test `apps/api/test/files/file-purge.spec.ts` |
| Versandprotokoll (`mail_log`) | die ganze Zeile | `MAIL_LOG_RETENTION_DAYS` | 90 Tage | der Betriebsnachweis „ist es angekommen" muss Wochen später beantwortbar sein, der eingefrorene Rumpf aber nicht ewig liegen; `apps/api/src/mail/mail-log-purge.service.ts`, Test `apps/api/test/mail/mail-log-purge.spec.ts` |
| KI-Freitext (`ai_usage.prompt`) | der getippte Text, physisch auf `NULL` | `AI_PROMPT_RETENTION_DAYS` | 30 Tage | dieselbe Frist wie der Papierkorb, damit es **eine** Zahl bleibt; `apps/api/src/ai/purge/ai-prompt-purge.service.ts`, Test `apps/api/test/ai/purge-prompt.spec.ts` |
| KI-Nutzung — Personenbezug | `user_id` der Nutzungszeile auf `NULL` | `AI_USAGE_PERSON_RETENTION_DAYS` | 365 Tage | zwölf Monate, weil die kleinste Frage an diese Zahlen ein Jahresvergleich ist; `apps/api/src/ai/purge/ai-prompt-purge.service.ts`, Test `apps/api/test/ai/purge-prompt.spec.ts` |
| KI-Nutzung — Zähler | nichts | — | ohne Frist | **Bewusst ohne Frist, nicht vergessen** ([ADR-0015 Nr. 8](../architecture/0015-ki-formularerstellung.md)): sobald die Zeile ihre Person verloren hat, trägt sie nur noch Organisation, Monat, Modell und Verbrauch — kein personenbezogenes Datum mehr. Die Kostenhistorie ist der Zweck, für den die Zeile existiert |
| Sitzungen | die `session`-Zeile einer abgelaufenen oder abgemeldeten Sitzung — physisch | `SESSION_RETENTION_DAYS` | 7 Tage | die Zeile trägt `user_id`, Zeitpunkte und die zuletzt gewählte Organisation; die Woche steht für „seit wann bin ich abgemeldet?". Gezählt ab dem **Tod** der Sitzung; `apps/api/src/auth/purge/session-purge.service.ts`, Test `apps/api/test/auth/session-purge.spec.ts` |
| Quittierte Betriebsalarme — Personenbezug | wer quittiert hat (`ops_alert.acknowledged_by_id`), wann und warum | — | ohne Frist | **Bewusst ohne Frist** ([ADR-0016](../architecture/0016-betriebsueberwachung-und-alarmierung.md) Nr. 4a): die Spalten leben nur, solange die Quittierung gilt. Der Wächter räumt sie ab, sobald die Kennzahl sich erholt oder die Frist abläuft, „Quittierung aufheben" sofort, und ein gelöschtes Konto setzt sie auf `NULL`. Eine zusätzliche Zeitfrist käme nie zum Zug und täuschte eine zweite Regel vor; mehr als fünf Zeilen kann die Tabelle nicht tragen. `apps/api/src/observability/ops-alert.service.ts`, Test `apps/api/test/observability/ops-acknowledgement.spec.ts` |
| Rücksetz-Links (`password_reset`) | die Zeile eines abgelaufenen oder eingelösten Links — Rücksetzung **und** Einladung (ADR-0024) — physisch | `PASSWORD_RESET_RETENTION_DAYS` | 7 Tage | dieselbe Zahl wie die Sitzungen und bewusst keine zweite ([ADR-0020](../architecture/0020-passwort-ruecksetzung.md)): derselbe Personenbezug, dieselbe nachgelagerte Frage. Gezählt ab Ablauf **oder** Einlösung; aufgeräumt vom Lauf der Sitzungen; `apps/api/src/auth/purge/session-purge.service.ts`, Test `apps/api/test/auth/session-purge.spec.ts` |

Eine Population **ohne** Frist ist zulässig genau dann, wenn die Tabelle sie als
solche führt und begründet — wer die Begründungsspalte leert, macht den
Drift-Test rot.

### 2.2 Zwei Grenzen, die eine Auskunft benennen muss

- **Ein Entwurf kann länger leben als 30 Tage.** Hat das Formular eine spätere
  Frist, stirbt der Entwurf mit ihr; die Grenze steht auf der Zeile selbst in
  `expires_at`.
- **Eine bereits versendete Mail ist außerhalb der Anwendung.** Das endgültige
  Löschen leert die Protokollzeile; die Nachricht im Postfach des Empfängers
  erreicht es nicht.

`SESSION_TTL_HOURS` ist keine Löschfrist: die Variable begrenzt eine Anmeldung,
nicht die Aufbewahrung eines Datums.

## 3. Technische und organisatorische Maßnahmen

**Jede Zeile nennt die Datei, die sie hält — kein Adjektiv.**

| Maßnahme | Was sie hält | Beleg |
|---|---|---|
| **Verschlüsselung im Ruhezustand** (Zugangswort, SMTP-Passwort, OIDC-Secret, KI-Schlüssel) | ein versiegelter Block je Zweck, mit eigenem Subkey und AAD an Organisation/Formular/Feld gebunden — ein Block aus einer fremden Zeile entsiegelt nicht | `apps/api/src/common/secret-box/secret-box.service.ts` · `apps/api/src/common/secret-box/secret-box.service.spec.ts` |
| **Der Schlüssel ist nicht im Backup wiederherstellbar** | eine Wiederherstellung mit fremdem `SECRET_BOX_KEY` sperrt aus, ohne sich zu verraten | `apps/api/test/backup/secret-box-key-loss.spec.ts` |
| **Zugriffskontrolle: Tenant-Scope** | jede fachliche Abfrage trägt `tenant_id` in der Bedingung, nicht im Filter danach | `apps/api/src/tenancy/tenant-scope.guard.ts` · `apps/api/test/tenancy/tenant-isolation.spec.ts` |
| **Zugriffskontrolle: Gruppenrechte** | Rechte je Gruppe, serverseitig; UI-Zustände sind Komfort | `apps/api/src/tenancy/group-permission.guard.ts` |
| **Zugriffskontrolle: Formular-Restriktion** | Formular-Rollen lassen sich nur herabstufen; der **unerlaubte** Zugriff ist der Nachweis | `apps/api/src/tenancy/form-permission.guard.ts` · `apps/api/test/tenancy/form-permission.spec.ts` |
| **Passwörter** | Argon2id (`memoryCost` 19 456, `timeCost` 2), geprüft wird auch, dass der Hash wirklich `argon2id` sagt | `apps/api/src/auth/password.ts` |
| **Sitzungen** | `httpOnly`, `SameSite=Lax`, `Secure` in Produktion; Token serverseitig | `apps/api/src/auth/cookie.ts` · `apps/api/src/auth/session.service.ts` |
| **CSRF-Schutz mutierender Routen** | Doppel-Vorlage aus Cookie und Kopfzeile | `apps/api/src/auth/csrf.guard.ts` |
| **Anmeldeversuche begrenzt** | Zähler je Adresse, dazu ein Dummy-Hash, damit „gibt es nicht" und „falsches Passwort" gleich lange dauern | `apps/api/src/auth/login-rate-limit.ts` · `apps/api/src/auth/dummy-password-hash.ts` |
| **Öffentliche Pfade: Rate-Limits** | jede Tür ohne Sitzung hat einen Zähler | `apps/api/src/public/public-forms.rate-limit.ts` |
| **Uploads: Positivliste und Größe serverseitig** | die Signatur an Offset 0 entscheidet, nicht die Endung; Grenzen aus einer Konstante, die auch der Frontdoor kennt | `apps/api/src/files/upload-pipeline.ts` · `packages/shared/src/file-types.ts` · `packages/shared/src/file-limits.ts` |
| **Anlagen gehen nur als Download hinaus** | `Content-Disposition: attachment` und `X-Content-Type-Options: nosniff` | `apps/api/src/files/content-disposition.ts` · `apps/api/test/files/retrieval.spec.ts` |
| **Protokollierung ohne Personenbezug** | JSON-Zeilen mit Anfrage-ID statt Inhalt; ein Test sendet Markenzeichenfolgen und sucht sie im Protokoll | `apps/api/src/observability/json-logger.ts` · `apps/api/src/observability/request-id.ts` · `apps/api/test/observability/log-hygiene.spec.ts` |
| **Der KI-Schlüssel bleibt serverseitig, und die Nutzlast ist eng** | der Schlüssel reist nur zum gepinnten Endpunkt; Kanarienvögel belegen, dass keine Antwortdaten mitgehen | `apps/api/test/ai/key-confinement.spec.ts` · `apps/api/test/ai/payload-canaries.spec.ts` |
| **Sicherung samt Probe** | Datenbank **und** Dateivolumen in einem Vorgang, verschlüsselt; die Wiederherstellung wird geprobt, nicht behauptet | `scripts/backup.sh` · `scripts/restore.sh` · `scripts/restore-drill.sh` |
| **Aufräumläufe mit Obergrenze** | kein unbeaufsichtigter Lauf hält eine Verbindung unbegrenzt | `apps/api/src/trash/purge/retention-purge.service.ts` |
| **Löschkonzept** | die Fristen aus Abschnitt 2, gegen den Code geprüft | `packages/shared/src/retention-doc.test.ts` |
| **Endgültiges Löschen nimmt das Protokoll mit** | die `mail_log`-Zeile bleibt als Betriebsnachweis, ihre personenbezogenen Spalten gehen | `apps/api/src/mail-log/mail-log-erasure.ts` · `apps/api/test/trash/permanent-delete.spec.ts` |

**Zwei Zeilen, die dem Betreiber gehören und nicht dem Code:** der
**TLS-Abschluss** liegt beim Reverse-Proxy vor der Anwendung (die Anwendung
setzt `Secure` am Session-Cookie und zählt Vorschaltproxys über
`TRUST_PROXY_HOPS`), und **EU-Hosting** ist eine Zusage des Hostingvertrags.

## 4. Die Einschaltbedingung der KI

> [ADR-0015](../architecture/0015-ki-formularerstellung.md) Nr. 13

Ohne Anbieter ist die Funktion abwesend: 404, kein Menüeintrag, die Anwendung
startet normal. ⚠️ **Das Einschalten ist ein Formularfeld, kein Deployment**
(*Systemverwaltung → KI*) — die fünf Vorbedingungen stehen deshalb in der
Ansicht, sobald jemand erstmals einen Anbieter wählt.

### 4.1 Die fünf Vorbedingungen

| # | Vorbedingung | Wer sie erfüllt |
|---|---|---|
| 1 | Ein **AV-Vertrag** (Art. 28 DSGVO) mit dem Anbieter liegt vor | Betreiber |
| 2 | Die **EU-Frage** ist beantwortet: Mistral läuft über den gewählten Regional-Endpunkt, **Anthropic nicht** | Betreiber |
| 3 | Der **Eintrag im Verarbeitungsverzeichnis** (1.7) ist geschrieben | Betreiber |
| 4 | Das **Kontingent je Organisation** ist gesetzt | Betreiber (Superadmin) |
| 5 | Die **30-Tage-Löschung des Freitexts** ist benannt (2.1) | Betreiber |

Die fünf stehen **einmal** im Code (`AI_PRECONDITIONS` in `@formsache/shared`)
und werden von der Ansicht *und* von diesem Dokument gelesen.

### 4.2 Die vier Annahmen, die beim Einschalten fällig werden

Ohne echten Anbieter-Schlüssel gibt es nichts zu messen:

| Ungemessene Annahme | Die Messung, die sie ablöst |
|---|---|
| Nimmt ein **echter** Anbieter das mitgeschickte Schema an? | ein Aufruf je Anbieter, dessen Antwort `aiFormDraftSchema` **parst**; die Nutzlast wird aufgezeichnet |
| Wie oft besteht die Antwort den Parse **nicht**? | ≥ 20 Läufe je Anbieter über die drei Beispiel-Prompts, gezählt |
| Lohnt sich `strict`? Er verlangt `additionalProperties: false` überall und **jede** Eigenschaft in `required` | dieselben Läufe: eine **Zahl** statt einer gelesenen Anbieterdokumentation |
| **Was kostet ein erzeugtes Formular an Token — trägt das Kontingent 50?** | Ein-/Ausgabe-Token mit Streuung, daraus die Kosten je Organisation und Monat |
