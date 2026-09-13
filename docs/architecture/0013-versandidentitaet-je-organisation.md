# 13. Versandidentität je Organisation — unteilbar und *fail closed*

- **Status:** superseded in Teilen — abgelöst am 2026-08-17
- **Date:** 2026-07-30

> **Abgelöst 2026-08-17 durch [ADR-0023](0023-getrennte-mailserver-instanz-organisation.md).**
> Die **Vererbung** gibt es nicht mehr: eine Organisation hat ihren eigenen
> Mailserver oder keinen, und der Mailserver der Installation gehört allein dem
> Betrieb. Was unten zur Unteilbarkeit der Versandidentität und zum
> *fail-closed*-Verhalten steht, gilt unverändert weiter — nur der Arm
> `source: 'system'` und alles, was an ihm hängt, ist fort.

## Context

[ADR-0004](0004-mail-db-queue.md) entscheidet, **wie** diese Anwendung Mail
verschickt: eine Warteschlange in der Datenbank, ein Worker als
Installationsressource, at-least-once mit Backoff und Versuchsobergrenze. Was er
nicht sagt, ist, **unter wessen Identität** eine Mail hinausgeht — gab es
darauf nur eine Antwort, weil es nur einen Transport gab: den aus `SMTP_*` der
`.env`, also den der Installation.

Das reicht nicht: **eine Organisation darf über ihren eigenen Mailserver
senden.** Damit hat der Worker zum ersten Mal
mehrere Gegenstellen, und die Anwendung muss je Zeile entscheiden, welche gilt.
Diese Entscheidung fällt **vor** der Umsetzung des Datenmodells, nicht danach:
eine Bauform, die erst hinterher korrigiert wird, ist eine Migration über
Zugangsdaten, die niemand mehr im Klartext hat.

Dazu kommt: `SMTP_*` und `PUBLIC_BASE_URL` verlassen die `.env` **ganz** und
werden Systemeinstellungen.
Die Trennlinie dort ist Henne-und-Ei — in der `.env` bleibt, was gebraucht wird,
**um an die Systemeinstellungen heranzukommen** —, und sie berührt diesen ADR nur
an einer Stelle: der „System-Block" ist eine Zeile, keine Umgebung.

Dieser ADR **ergänzt** ADR-0004 und ersetzt ihn nicht. Die Semantik der Queue
(at-least-once, `FOR UPDATE SKIP LOCKED`, Backoff, Obergrenze, 90-Tage-Purge)
bleibt unberührt.

## Decision

### 1. Der SMTP-Block ist unteilbar — als **Typ**, nicht als Prüfung

Die Versandidentität einer Organisation ist eine **diskriminierte Union**:

```ts
{ source: 'system' }
| { source: 'own'; host; port; secure; user; password; from }
```

Nicht ein Objekt aus lauter optionalen Feldern mit einer Prüfung darüber. Der
Unterschied ist der ganze Punkt: **ein Dokument, das nur `from` setzt, ist nicht
ausdrückbar.** Es gibt dafür keinen Test, weil es keinen Typ gibt — und das ist
stärker als jeder Test, den man vergessen kann.

**Der Nachweis hängt deshalb an `pnpm typecheck`, nicht an der Suite.** Vitest
fährt über SWC, das Typen streicht ohne sie zu prüfen; ein grüner Vitest-Lauf
sagt über diese Zusicherung nichts. Dieselbe Falle hat `PUBLIC_BASE_URL` gestellt.

### 2. Warum unteilbar — SPF/DKIM, nicht Ordnungsliebe

Die gefährliche Mischung ist **System-Transport + eigene Absenderadresse**.

Der System-Transport ist für die Domäne der Installation per SPF und DKIM
autorisiert. Dürfte eine Organisation nur die Adresse ersetzen und weiter über den Server
des Systems senden, verschickte er **signierte, technisch einwandfreie Post unter
einer beliebigen Adresse dieser Domäne** — etwa `vorstand@example.org`. Das ist
Identitätsfälschung mit der Autorisierung der Installation, und sie ist von echter
Post nicht zu unterscheiden, weil sie es technisch nicht *ist*.

Die Gegenrichtung — eigener Transport, Adresse des Systems — ist harmloser und
trotzdem falsch: sie scheitert beim Empfänger an SPF und beschädigt dabei den Ruf
der System-Domäne, ohne dass die Organisation erfährt, warum seine Mail im Spam landet.

### 3. Was **nicht** zum Block gehört

- **Der Anzeigename.** Er ist eine Eigenschaft der Organisation und steht vor
  der Adresse; eine Organisation, die über den System-Transport sendet,
  unterschreibt trotzdem mit ihrem Namen. Er
  fälscht damit keine Identität — die Adresse bleibt die des Systems.
- **Die Basis-Adresse** (`PUBLIC_BASE_URL`). Sie beschreibt, **wo eine Organisation
  erreichbar ist**, nicht seine Mail-Identität. Sie wird je Organisation gesetzt und ist
  ausdrücklich *kein* Teil des unteilbaren Blocks: eine Organisation darf unter seiner
  eigenen Adresse erreichbar sein und trotzdem über den System-Mailserver
  senden. Das ist der Normalfall und keine Mischung.

### 4. *Fail closed* — kein Rückfall auf den System-Block

Scheitert der eigene Transport einer Organisation, geht die Zeile auf `failed` mit
lesbarem Grund und das Versandprotokoll zeigt sie. **Es wird nicht über den
System-Transport nachgereicht.** Sonst ginge unter der Identität der Installation
hinaus, was eine Organisation bewusst unter seiner eigenen verschicken wollte — also genau
die Fälschung aus Nr. 2, nur ausgelöst durch einen Netzwerkfehler statt durch
eine Konfiguration.

Dasselbe gilt für einen **unparsbaren oder gemischten** gespeicherten Block: er
wird abgelehnt, nicht teilweise benutzt. Ein per Rohschreibzugriff eingesetzter
halber Block ist keine „Konfiguration mit Lücken", sondern ein Zustand, den die
Anwendung nicht erzeugen kann — sie deutet ihn nicht, sie verweigert ihn.

**Die Absendung selbst bleibt davon unberührt.** Die bestehende Regel
gilt unverändert weiter: die `response`-Zeile steht, die Bestätigungsseite kommt.
Nicht zustellbar zu sein ist ein Mail-Problem, kein Anmeldungsproblem — dieselbe
Trennung gilt später auch für das Versandbudget.

**Der Testaufbau trägt diesen Nachweis, nicht die Zusicherung.** „Die Mail ging
nicht raus" bleibt grün, wenn der Fallback ebenfalls scheitert. Der
System-Transport im Test muss **funktionsfähig** sein, der eigene kaputt, und
geprüft wird der **Zähler des System-Transports** (= 0). Alles andere misst
nichts.

### 5. „Nichts eingerichtet" ist nicht „kaputt"

Drei Zustände, drei verschiedene Antworten — und sie werden nicht
zusammengefasst:

| Zustand | Antwort |
|---|---|
| Organisation erbt den System-Block, und der ist **nicht eingerichtet** | Zeile bleibt `queued` mit dem Grund. Nichts wurde versucht, nichts wurde verweigert; ein später eingerichteter Server sendet sie. |
| Organisation hat einen **eigenen** Block, und die Zustellung scheitert | `failed` mit lesbarem Grund. |
| Gespeicherter Block **unparsbar oder gemischt** | `failed` mit lesbarem Grund. |

Die erste Zeile ist der Grund, warum die Anwendung ohne Mailserver startet
, und sie bleibt
bestehen. Sie zu einem `failed` zu machen wäre der bequeme Weg, sich einen
Sonderfall zu sparen — und er kostet genau die Eigenschaft, die eine frisch
aufgesetzte Installation arbeitsfähig macht.

### 6. Das SMTP-Passwort einer Organisation ist ein Datenbank-Geheimnis

`SecretBox` mit **Tenant und Feld als AAD**, wie das Zugangswort: `SecretField`
bekommt `'smtp.password'`.

**Naheliegend wäre „kein neues `SecretField`, SMTP ist ein
*Umgebungs*-Geheimnis".** Das gälte, solange es eines wäre. Sobald der Block in
die Systemeinstellungen wandert, ist es keines mehr. Eine Organisation tippt
diese Zugangsdaten in eine Oberfläche; sie gehören
damit in dieselbe Kategorie wie das Zugangswort und nicht in dieselbe wie
`SECRET_BOX_KEY`.

Das Feld im AAD ist nicht Zierrat: ohne es ließe sich ein versiegeltes
OIDC-Client-Secret in die SMTP-Spalte desselben Organisation schieben; ohne den Tenant
ließe sich ein Wert über die Organisation-Grenze verschieben.

### 7. Transporte werden je Organisation zwischengespeichert und beim Ändern verworfen

Ein Transport je Organisation, gehalten über Worker-Läufe hinweg. Der Zwischenspeicher
wird beim Ändern des Blocks **verworfen**.

> ⚠️ **Der Zwischenspeicher spart keine Verbindung.** Er spart das
> Transporter-Objekt und die Fingerabdruck-Prüfung, **nicht die
> SMTP-Verbindung**: `nodemailer` öffnet ohne `pool: true` je `sendMail` eine
> neue.
> **Und `pool: true` ist bewusst *nicht* gesetzt.** Es wurde probiert und
> brach einen Sicherheitsnachweis: eine gehaltene Session authentifiziert
> **einmal**, also erreicht der Test „der Server lehnt ab jetzt Anmeldungen ab"
> sein `535` nie mehr. Einen Sicherheitsnachweis umzuschreiben, damit ein Cache
> seine Beschreibung einhält, ist die falsche Richtung — und eine dauerhaft
> offene Verbindung zu einem Host, den ein **Organisation-Admin** gewählt hat, ist
> ohnehin die schlechtere Haltung (siehe die Angriffsfläche unter
> „Consequences"). Das Verwerfen bleibt tragend: es entscheidet, gegen
> **welche Gegenstelle** die nächste Verbindung geht.

Ohne dieses Verwerfen entsteht die stillste Falle hier: eine Organisation wechselt
ihren Mailserver, die Oberfläche zeigt den neuen, und gesendet wird bis zum
nächsten Neustart über den alten. Niemand sieht es, weil beides funktioniert.

Und: **eine Organisation mit totem Mailserver hält die Warteschlange der anderen nicht
auf.** Die eingestellten Timeouts begrenzen die Wartezeit je Zustellversuch;
sie begrenzen nicht, dass eine Organisation einen Lauf für alle belegt.

> ⚠️ **Bahnen je Organisation allein lösen das nicht — sie verzögern, sie
> verhindern nicht.** Nichts geht verloren, und die übrigen Bahnen liefern im
> selben Lauf. Aber das Zeilenbudget eines Laufs ist **geteilt**: ohne Deckel je
> Bahn kann eine Organisation mit einem Host, der annimmt und schweigt, ihre
> Bahn über das ganze Budget hinweg belegen — in der Größenordnung einer
> Stunde —, und weil `runOnce` auf alle Bahnen wartet und `tick` koalesziert,
> startete in dieser Zeit **kein neuer Lauf**, auch nicht für die Organisationen
> jenseits der acht Bahnen. Verschärfend: die Zeilen entstehen aus
> **öffentlichen** Einreichungen, ihre Zahl ist also von außen beeinflussbar —
> gegen eine Organisation, die lediglich einen falschen Host eingetragen hat.
>
> **Beide Hälften der Abhilfe sind gebaut und gemessen:**
> `MAIL_WORKER_LANE_BATCH_MAX` deckelt, was **eine Bahn** von einem Lauf nehmen
> darf (`MAIL_WORKER_BATCH_MAX / MAIL_WORKER_TENANT_LANES`, belegt in
> `mail-worker-lanes.spec.ts`), und `drainLane` **bricht die Bahn nach der
> ersten stillen Zeile ab** — die nächste kaufte dasselbe Schweigen zum selben
> Preis (belegt in `mail-send-timeout.spec.ts`).

## Consequences

- **Der Worker bekommt eine Identitätsauflösung je Zeile.** Sie liegt als eigene
  Datei neben ihm (`mail-identity.service.ts`), nicht in ihm — derselbe Schnitt,
  der `settings-enforcement.ts` von `public-forms.service.ts` getrennt hat.
- **Eine Organisation kann sich selbst aussperren.** Ein Tippfehler im eigenen Block heißt
  *fail closed*, also: nichts geht hinaus, bis er korrigiert ist. Genau dagegen
  ist die Testmail Pflicht und keine Bequemlichkeit — sie prüft den
  **gespeicherten** Block, damit es keinen zweiten Eingangspfad für Zugangsdaten an der `SecretBox` vorbei
  gibt.
- **Der System-Block liegt in den Systemeinstellungen**, nicht in der
  `.env`. Die `.env` behält nur, was *vor* dem Lesen der Datenbank
  gebraucht wird. Weil eine vergessene Stelle dabei **gar nichts** rot macht,
  hängt an derselben Änderung ein Wächter, der `apiEnvSchema`, `.env.example` und
  `docker-compose.yml` in **beide** Richtungen vergleicht.
- **Eine Organisation-Admin darf einen beliebigen Host und Port benennen, den der Server
  anspricht — das ist eine bewusst getragene Angriffsfläche.** Er kann
  `127.0.0.1:6379`, `169.254.169.254:80` oder irgendeine RFC-1918-Adresse
  eintragen. Sobald der Worker verbindet, wird die Fehlermeldung zum **Orakel**
  („connection refused" gegen Zeitüberschreitung gegen Protokollfehler) und
  damit zu einem Portscanner aus dem Netz des Servers heraus; ein Host, der
  annimmt und schweigt, belegt zudem je Versuch einen Worker-Platz.
  **Warum wir es trotzdem tragen:** der Handelnde ist ein angemeldeter
  Organisations-Admin mit `can_manage_settings` **und** `can_view_responses` — jemand,
  dem die Installation ohnehin sämtliche Antworten ihrer Organisation anvertraut.
  Und einen beliebigen Relay-Host benennen zu dürfen **ist der Zweck** dieser
  Entscheidung; eine Host-Positivliste bräche legitime Organisationen, die über
  einen gemeinsamen Server oder den Server ihres Providers senden.
  **Zwei Auflagen folgen daraus**, und sie sind keine Empfehlung: der
  Transportfehler wird **nicht wörtlich** in die Antwort der Testmail
  durchgereicht, und `mail_log.last_error` bleibt bei den Kategorien, die ein
  Bearbeiter zum Handeln braucht, statt bei dem, was ein Scanner zum Kartieren
  braucht. Die Summenbegrenzung eines schweigenden Hosts über *alle* Versuche
  hinweg bleibt offen.
  **Restrisiko, benannt statt weggeschrieben: die Kategorien vergröbern das
  Orakel, sie schließen es nicht.**
  „Nicht erreichbar" (abgewiesene Verbindung) und „keine Antwort"
  (Zeitüberschreitung) unterscheiden weiterhin einen **geschlossenen** von einem
  **offenen, aber nicht SMTP sprechenden** Port — und selbst wenn man sie
  zusammenlegte, bliebe der Zeitabstand zwischen den Zeilen im Versandprotokoll
  ein Kanal: eine Abweisung kommt sofort, eine Zeitüberschreitung nach zehn oder
  fünfzehn Sekunden. Ein Portscanner ist damit **langsamer und gröber**, nicht
  unmöglich. Getragen wird das aus demselben Grund wie die Fläche selbst; wer
  hier etwas ändert, ändert es in dem Wissen, dass vier Kategorien vier
  Handlungen eines Bearbeiters entsprechen und eine fünfte keine mehr wäre.
- **`Reply-To` je Benachrichtigung** ist **nicht** entschieden und nicht
  Teil. Wer es baut, entscheidet zuerst, ob es zum unteilbaren Block
  gehört — die Antwort ist nicht offensichtlich: `Reply-To` wird nicht signiert
  und fälscht deshalb keine Identität, es lenkt aber Antworten.

## Fortschreibung 2026-08-15: die Testmail — Systemebene und ein wählbarer Empfänger (Review-Befund 29)

- **Status:** accepted
- **Date:** 2026-08-15
- **Ersetzt:** an den *Consequences* oben die Annahme, der Empfänger einer
  Testmail sei zwingend die Adresse aus der Sitzung. Alles andere gilt
  unverändert — insbesondere die getragene Angriffsfläche „beliebiger Host" und
  die zwei Auflagen daraus.

### a) Es gibt eine Testmail auf Systemebene

Der Reiter *Mailserver* der Systemverwaltung konnte den
Mailserver der Installation einrichten und **nicht prüfen**. Die einzige
Testmail der Anwendung hing an `TenantScopeGuard` und ging über den Block der
aktiven Organisation; den System-Block traf sie nur zufällig — nämlich genau
dann, wenn diese Organisation gerade erbte. Wer den System-SMTP prüfen wollte,
musste sich also eine passend konfigurierte Organisation suchen und prüfte
danach eine Konfiguration, die er nicht gemeint hatte.

**Entschieden:** `POST /api/admin/system-settings/mail/test`
(`apps/api/src/mail/system-test-mail.controller.ts`), hinter
`SessionGuard → SuperadminGuard → TenantScopeGuard`, mit demselben
`TEST_MAIL_RATE_LIMIT` wie die Organisationsroute — **importiert**, nicht
abgeschrieben, weil es dieselbe Eigenschaft verteidigt. Die Route reicht
`MailIdentityService.resolve` den festen Wert `'system'` und sieht die
`smtp`-Spalte der Organisation damit gar nicht (der Zweig endet vor der Spalte,
ADR-0020).

Drei Punkte, die eine Erklärung brauchen:

- **`SuperadminGuard` entscheidet, wer darf.** `can_manage_settings` einer
  Organisation reicht ausdrücklich nicht — dieselbe Grenze, die
  `SystemSettingsController` für Lesen und Schreiben dieser Zeile zieht.
- **`TenantScopeGuard` entscheidet nur, wohin der Beleg kommt.**
  `mail_log.tenant_id` ist `NOT NULL`; jede Protokollzeile gehört einer
  Organisation. Der Scope sagt also, in wessen Versandprotokoll der Versuch
  nachlesbar ist, **nicht**, welcher Block angewählt wird. Der Preis ist
  benannt: ein Superadmin ohne jede Mitgliedschaft bekommt 403 statt einer
  Testmail. Die Alternativen wären gewesen, den Beleg wegzulassen — bei der
  Route, die auf Zuruf nach außen wählt, die falsche Richtung — oder eine Zeile
  ohne Organisation zu erfinden, also die Spalte aufzuweichen, an der die
  Mandantentrennung des Versandprotokolls hängt.
- **Der Controller liegt im Mailmodul, nicht im `SystemSettingsModule`.** Seine
  Adresse gehört zur Systemverwaltung, seine Umsetzung zum Mailmodul, wo
  Identitätsauflösung und Transport liegen; der umgekehrte Weg wäre ein
  Modulzyklus (`TestMailModule` importiert `SystemSettingsModule` bereits).

Die Zeile führt `trigger = 'system'`, und das ist keine Kosmetik: an dieser
Spalte wählt der Worker den Block, wenn jemand später „↻ Erneut" drückt. Eine
als `submit` abgelegte Systemtestmail ginge beim zweiten Versuch über den Block
der Organisation — also über einen anderen als den geprüften.

### b) Der Empfänger darf abweichen

Bisher war der Empfänger fest die Adresse aus der Sitzung, mit einer ernst
gemeinten Begründung: diese Route wählt auf Zuruf einen beliebigen Rechner an,
ein freier Empfänger machte daraus einen Portscanner beziehungsweise ein offenes
Relay. Der Nutzer verlangt eine angebbare Adresse. Die alte Begründung wird
deshalb **fortgeschrieben und nicht weggewischt** — hier steht, welcher Teil von
ihr trägt:

- **Der Portscanner ist nicht berührt.** Er hing am freien *Host*, nicht am
  freien Empfänger. `testMailRequestSchema` bleibt ein `strictObject` **ohne ein
  einziges Transportfeld**; der Block kommt aus der Spalte, und der Grund eines
  Fehlschlags ist auf dieser Route immer eine Kategorie und nie der Wortlaut des
  Gegenübers. Nichts davon hat sich bewegt.
- **Ein Relay ist es nicht, weil der Inhalt nicht wählbar ist.** Betreff und
  Rumpf sind fester Text der Anwendung; die Anfrage trägt kein Feld, aus dem ein
  Zeichen davon käme. Wer die Route an eine fremde Adresse richtet, kann ihr
  einen einzigen, immer gleichen Satz schicken — und der sagt, dass er nichts
  bedeutet. Ein Verteiler wird daraus auch nicht: eine Anfrage ist genau eine
  Adresse, und nichts auf diesem Weg zerlegt eine Zeichenkette.
- **Die Berechtigung deckt es ab.** Wer durchkommt, hält `can_manage_settings`
  **und** `can_view_responses` in dieser Organisation. Diese Person kann heute
  schon ein Formular anlegen, eine Benachrichtigung mit fester Empfängeradresse
  daran hängen und es absenden — dann geht eine Mail **mit frei gewähltem
  Inhalt** an eine frei gewählte Adresse hinaus, über denselben Block. Die Route
  gibt ihr also keine Fähigkeit, die sie nicht in stärkerer Form längst hat.
- **Zahl und Spur bleiben.** Zehn Versuche je Minute und Herkunftsadresse, jeder
  Versuch schreibt eine `mail_log`-Zeile, und **in dieser Zeile steht die
  gewählte Adresse**.

**Restrisiko, benannt statt weggeschrieben:** ein Berechtigter kann die Route
benutzen, um zu erfahren, ob ein Relay eine fremde Adresse annimmt („Der
Mailserver hat die Nachricht nicht angenommen" gegen „gesendet") —
Adressprüfung mit zehn Versuchen je Minute. Gegen einen *eigenen* Block
beantwortet er damit eine Frage über einen Server, den er selbst betreibt; gegen
den geerbten System-Block ist es dieselbe Auskunft, die er über eine
Benachrichtigung ebenfalls bekäme. Getragen, nicht geschlossen.

## Fortschreibung 2026-08-21: die Testmail ohne Organisation (Review-Runde 3 Nr. 12)

Der Befund: *„Systemeinstellungen: Testmail sollte auch ohne Orga gehen. Dann
halt nicht protokolliert."*

Die Fortschreibung von 2026-08-15 hatte die Systemroute an `TenantScopeGuard`
gehängt, und die Begründung war **nie die Berechtigung** (die entscheidet
`SuperadminGuard`), sondern die **Ablage der Zeile**: `mail_log.tenant_id` ist
`NOT NULL`, jede Zeile dieses Protokolls gehört einer Organisation. Der Preis
war dort benannt — „ein Superadmin ohne Mitgliedschaft bekommt 403" — und
falsch bemessen: getroffen hat es ausgerechnet den Zustand, in dem man den
Mailserver zum ersten Mal prüfen will, die **Erstinbetriebnahme**, wo die
erste Organisation erst im letzten Schritt entsteht.

Die dritte Möglichkeit, die damals nicht erwogen wurde, ist die gewählte:
**senden, nicht protokollieren.**

- Die Route trägt jetzt `OptionalTenantScopeGuard` — derselbe Bereich aus
  derselben Quelle (den Mitgliedschaften der Anfrage), nur ohne die Absage.
- Mit Organisation bleibt alles, wie es war: eine `mail_log`-Zeile mit
  `trigger: 'system'` im Protokoll dieser Organisation.
- Ohne Organisation geht die Mail über denselben Systemblock hinaus und
  hinterlässt **nichts** (`TestMailService.sendWithoutTenant`).

⚠️ **Die Spalte bleibt `NOT NULL`.** Sie trägt die Mandantentrennung des
Versandprotokolls; sie für einen Knopf aufzuweichen wäre der teuerste denkbare
Tausch. Der Verlust wird stattdessen **benannt**: die Karte schreibt an den
Knopf, dass dieser Versuch sich hinterher nicht nachlesen lässt und die
Meldung darunter alles ist, was von ihm bleibt.

Belegt in `apps/api/test/mail/system-test-mail-without-tenant.spec.ts`: die
Mail geht gegen einen echten SMTP-Empfänger hinaus, es entsteht **keine**
Protokollzeile, und wer kein Superadministrator ist, kommt weiterhin nicht
durch.

## Alternatives considered

1. **Feldweises Überschreiben mit einer Konsistenzprüfung darüber.** Die
   naheliegende Bauform: ein Objekt aus optionalen Feldern, dazu eine Regel „wenn
   `host`, dann auch `user`". Verworfen, weil die Regel eine *Laufzeit*-Zusage
   ist, an einer Stelle steht und in genau dem Moment umgangen wird, in dem
   jemand einen zweiten Schreibpfad baut. Die Union macht daraus eine Aussage des
   Typsystems, die auch der Rohschreibzugriff nicht aushebeln kann — sie wird
   dort zur Ablehnung.
2. **Nur die Absenderadresse je Organisation, Transport immer vom System.** Billig, löst
   den fachlichen Wunsch scheinbar („die Mail soll von uns kommen") — und ist
   exakt die Fälschung aus Nr. 2. Ausgeschlossen.
3. **Rückfall auf den System-Transport, wenn der eigene scheitert.** Erhöht die
   Zustellquote und ist deshalb verlockend. Verworfen: er verschickt unter der
   Identität der Installation, was jemand bewusst unter seiner eigenen
   verschicken wollte, und er tut es genau dann, wenn niemand hinsieht.
4. **Ein eigener Worker je Organisation.** Löst Nr. 7 auf der Betriebsebene statt im
   Code. Verworfen: ADR-0004 macht den Worker zur Installationsressource, und
   Prozesse je Mandant sind ein Betriebsmodell, das diese Anwendung ausdrücklich
   nicht verlangt (hosting-agnostisch).
