# 22. Erstinbetriebnahme — eine Seite, ein Befehl, eine Transaktion

- **Status:** accepted — **fortgeschrieben am 2026-08-18**
- **Date:** 2026-08-15

> **Fortschreibung 2026-08-18.** Aus der einen Maske ist ein
> **Einrichtungsassistent** geworden: sieben Schritte durch alle
> Systemeinstellungen, jeder außer dem ersten überspringbar, und was offen
> bleibt, steht danach als Liste offener Punkte in der Systemverwaltung. Was
> unten steht, beschreibt den Stand vom 2026-08-15 und bleibt lesbar, weil die
> Begründungen weiterhin tragen — insbesondere §3 (die Bedingung in derselben
> Transaktion) und §6 (`is_superadmin` ist über keine Route setzbar). Was sich
> geändert hat und warum, steht in der
> [Fortschreibung](#fortschreibung-2026-08-18-aus-einer-maske-wird-ein-assistent)
> am Ende — **sie geht den §§ 1 und 2 vor**, soweit sie die Gestalt der
> Einrichtung und die erste Organisation betreffen.

## Context

Eine frisch aufgesetzte Installation von Formsache hat eine leere Datenbank.
Sie zeigt die Anmeldung — und es gibt kein Konto, mit dem man sich anmelden
könnte. [`docs/kb/09-betrieb.md`](../kb/09-betrieb.md) beschrieb dafür bis
hierher genau zwei Wege:

1. **Den Seed.** Er ist ausdrücklich ein Werkzeug der Entwicklung: er legt
   `admin@example.org` mit einem Kennwort an, das in `.env.example`, im
   öffentlichen Quelltext und im `migrate`-Abbild steht. Genau deshalb bricht er
   unter `NODE_ENV=production` ab, solange die Kennwörter auf den Vorgabewerten
   stehen (`apps/api/prisma/seed.ts`, belegt in
   `apps/api/test/prisma/seed-production-guard.spec.ts`). Er legt außerdem zwei
   Beispielorganisationen an, die niemand haben will, der die Software
   tatsächlich benutzt.
2. **Handarbeit in der Datenbank.** `docker-compose.prod.yml` setzt die
   `SEED_*`-Variablen auf `!reset null` und setzt damit genau diesen Weg voraus.

Der zweite ist kein Weg. Er verlangt von einer Betreiberin, einen Argon2id-Hash
zu erzeugen, ihn mit `psql` in eine `user`-Zeile zu schreiben und dabei zwei
CHECK-Bedingungen und die Spalte `is_superadmin` zu treffen — für den ersten
Schritt einer Software, die man gerade erst installiert hat. Der Nutzer hat es
kürzer gesagt: *„Wie soll das denn ohne Seed funktionieren? Der Nutzer meldet
sich doch nicht in der DB an."*

**Zu entscheiden war deshalb nicht, *ob* es einen dritten Weg gibt, sondern
welche Gestalt er hat — und wie eine Route, die einen Superadministrator ohne
Anmeldung anlegt, nicht zur schlimmsten Schwachstelle der Anwendung wird.** Denn
das ist sie, wenn sie einen Tag zu lange lebt: sie legt das Konto an, das jede
Organisation, jedes Formular und jede Antwort dieser Installation sehen darf.

## Decision

### 1. Eine Einrichtungsseite — der dritte Zustand vor der Anmeldung

Solange die Installation **null Zeilen in `user`** hat, zeigt die Anwendung
statt der Anmeldung eine Einrichtung: erster Superadministrator (Name, E-Mail,
Passwort) und — **überspringbar** — eine erste Organisation.

Sie ist **keine Route im angemeldeten Bereich**, sondern ein Zustand davor,
entschieden in `apps/web/src/App.tsx` an derselben Stelle, an der die Anwendung
schon zwischen „Sitzung da" und „Anmeldeseite" entscheidet. Der Grund ist, dass
es hier nichts zu navigieren gibt: es gibt keine Sitzung, keine Organisation und
keine zweite Seite. Eine Adresse dafür wäre eine Adresse, die man aufrufen kann,
wenn sie nichts mehr tut — und die man dann erklären muss.

Gefragt wird `GET /api/setup`, und zwar **nur**, wenn die Sitzungsprüfung eine
saubere 401 geliefert hat. Wer angemeldet ist, fragt gar nicht; eine
*fehlgeschlagene* Sitzungsprüfung führt zur Anmeldung mit Hinweis. Die Richtung
ist Absicht: aus „wir wissen es nicht" darf nie eine Einrichtungsmaske werden.

**Verworfen: eine Route `/einrichtung` in der Routentabelle.** Sie hätte
denselben Zustand zweimal beschrieben — einmal als Adresse, einmal als
Bedingung — und die Frage aufgeworfen, was `/einrichtung` auf einer
eingerichteten Installation zeigt.

### 2. Ein Superadministrator ohne Organisation ist ein gültiger Endzustand

Das Anlegen der ersten Organisation lässt sich überspringen. Das Datenmodell
trägt es bereits: `user` hat keine `tenant_id`, und `SuperadminGuard` läuft ohne
`TenantScopeGuard`. Es muss also nichts erzwungen werden — und es soll auch
nichts erzwungen werden: wer eine Installation erst betreiben und die
Organisationen später anlegen will, soll das nicht mit einer
Wegwerf-Organisation bezahlen, die danach in jeder Übersicht steht.

Im Wire-Contract ist das ein **`nullable`, nicht `optional`** (`tenant: null`):
Überspringen ist eine Entscheidung, die im Dokument steht, kein vergessener
Schlüssel.

**`POST /api/setup` antwortet 204 ohne Körper und stellt keine Sitzung aus.**
Wer eingerichtet hat, meldet sich anschließend normal an. Das ist eine Zeile
weniger Macht für die gefährlichste Route der Anwendung — und beweist nebenbei,
dass die eben gesetzten Zugangsdaten funktionieren.

### 3. Die Bedingung steht in derselben Transaktion wie der Schreibvorgang

„Gibt es schon einen Nutzer" und „lege einen an" sind zwei Anweisungen, und
zwischen zwei Anweisungen passt eine zweite Anfrage. Beides steht deshalb in
**einem** `$transaction`-Block (`apps/api/src/setup/first-superadmin.ts`), und
der Block nimmt vorher eine **Vorsperre**
(`pg_advisory_xact_lock`), die alle Aufrufer in eine Reihe stellt.

Die Bedingung ist **null Zeilen in `user`** — nicht „kein Superadministrator",
nicht „keine Mitglieder". Die schwächere Bedingung wäre eine offene Tür in jeder
Installation, deren einziger Superadministrator gelöscht wurde, also genau dann,
wenn sie am teuersten ist.

**Verworfen: `Serializable`.** Korrekt, aber die Kollision kommt als Fehler
40001 zurück und müsste von Hand in „schon eingerichtet" übersetzt und
wiederholt werden. Ein Wiederholungspfad, der genau einmal im Leben einer
Installation läuft, ist ein Pfad, den nie jemand geprüft findet.

**Verworfen: eine billige Vorprüfung vor dem Hashen.** Sie hätte neben der einen
verbindlichen Prüfung eine zweite gestellt, die genauso aussieht und nichts
garantiert. Der Preis der Ablehnung ist benannt: eine eingerichtete Installation
zahlt für einen Fremdaufruf eine Argon2id-Berechnung, bevor sie 404 sagt —
genauso viel wie für einen erfundenen Anmeldeversuch, und durch dasselbe
Rate-Limit gedeckelt.

**Verworfen: ein eindeutiger Index auf `is_superadmin`.** Er würde mehr als
einen Superadministrator für immer verbieten. Das ist nicht die Regel dieser
Anwendung; sie hat nur keinen Weg, über den *eine Route* einen zweiten anlegen
könnte.

⚠️ Die Vorsperre hängt an **`READ COMMITTED`**, dem Vorgabewert von PostgreSQL
und von Prisma: dort nimmt jede Anweisung ihre eigene Momentaufnahme, also sieht
die Prüfung *nach* der Sperre, was die Vorgängerin bestätigt hat. Unter
`REPEATABLE READ` läge die Momentaufnahme vor der Sperre und die Reihe wäre
wirkungslos.

### 4. Ein Befehl als zweiter Weg — dieselbe Funktion, nicht derselbe Code zweimal

`scripts/create-superadmin.sh` (→ `apps/api/src/setup/create-superadmin.main.ts`)
ist der Weg für Betreiber, die die Einrichtungsseite nie freigeben wollen: hinter
einem Proxy, in einer Umgebung, in der die Anwendung erst erreichbar sein darf,
wenn sie eingerichtet **ist**.

Er ruft **dieselbe** Funktion mit derselben Bedingung, derselben Vorsperre und
demselben Schema wie die Route. Zwei Fassungen wären zwei Gelegenheiten, die
Einmaligkeit zu verlieren — und diese hier liefe unbeobachtet auf einem Server.

**Das Passwort steht nie in `argv`.** Es kommt aus `FORMSACHE_ADMIN_PASSWORD`
oder wird verdeckt und zweimal abgefragt; `--password` wird ausdrücklich
abgewiesen. Was in `argv` steht, steht in `ps`, in der Shell-Historie und in
jedem Prozessprotokoll, das mitschreibt.

### 5. Rate-Limits: zehn zum Schreiben, hundertzwanzig zum Fragen

`POST /api/setup` bekommt **zehn je Minute und Adresse** — dieselbe Zahl wie die
Anmeldung, weil ein Aufruf dasselbe kostet (siehe Nr. 3).

`GET /api/setup` bekommt **hundertzwanzig**, und das ist die weniger offen-
sichtliche Entscheidung: die Route wird von *jedem abgemeldeten Seitenaufruf*
einmal gefragt, ein Leben lang, nicht nur am Einrichtungstag. Die registrierte
Vorgabe (zehn) wäre für eine Geschäftsstelle hinter einer Adresse zu wenig — und
ein Zähler, den echte Nutzung reißt, wird in der einen Stunde hochgesetzt, in
der er zählt. Ein Aufruf kostet einen Indexzugriff; die Antwort ist ein Boolean.

### 6. Die Ausnahme ist benannt, nicht aufgeweicht

`is_superadmin` bleibt über **keine** Route setzbar. `admin.repository.ts`
schreibt den ersten Administrator einer Organisation Feld für Feld statt per
Spread; `tenancy/tenant-scope.ts` hält dieselbe Linie für die Nutzerverwaltung;
kein Schema in `packages/shared` hat ein Feld dafür — `setupRequestSchema`
eingeschlossen.

`first-superadmin.ts` ist die eine Ausnahme, und sie ist eine **Eigenschaft des
Codes, keine Angabe des Aufrufers**: der Wert steht wörtlich als `true` im
`create`, und es gibt keinen Weg, auf dem ein Anfragedokument diese Spalte
erreicht. Ein Integrationstest hält daneben fest, dass `isSuperadmin: true` im
Rumpf einer *anderen* Route weiterhin wirkungslos ist.

⚠️ **Präzisierung seit dem 2026-08-19** ([ADR-0029](0029-zweiter-superadministrator.md)):
Es gibt jetzt eine **zweite** Stelle, die die Spalte setzt — die Ernennung
eines zweiten Superadministrators in der Systemverwaltung. Der Satz oben ist
damit auf seinen Kern zurückzulesen, und der hat sich nicht bewegt: **kein
Anfragedokument erreicht diese Spalte.** `superadminPromoteSchema` trägt genau
ein Feld (eine E-Mail-Adresse), der Wert `true` steht auch dort wörtlich im
Code, und die Route liegt hinter `SuperadminGuard` — sie gibt also nur weiter,
was der Aufrufer selbst schon hat. Was fällt, ist allein die Zusatzaussage
„über *keine* Route"; sie war nie die Sicherung, sondern ihre damalige Folge.

### 7. Der Seed bleibt, was er ist

Er wird nicht geändert und nicht ersetzt: er ist das Werkzeug der Entwicklung —
zwei Beispielorganisationen, drei Konten, idempotent, und mit seinem Riegel
gegen `NODE_ENV=production`. Was sich ändert, ist die Betriebsdokumentation:
`docs/kb/09-betrieb.md` beschreibt jetzt Einrichtungsseite, Befehl und den Seed
als das, was er ist, statt „Handarbeit in der Datenbank" als zweiten von zwei
Wegen zu nennen.

## Consequences

- Eine frische Installation ist ohne Datenbankzugriff bedienbar. Der bisher
  dokumentierte Weg „von Hand anlegen" entfällt aus der Anleitung.
- Es gibt zwei zusätzliche Routen, die **ohne Sitzung** erreichbar sind. Beide
  hören auf zu existieren, sobald die Installation ein Konto hat; die schreibende
  antwortet danach 404, als gäbe es sie nicht.
- `GET /api/setup` verrät, ob eine Installation eingerichtet ist. Das ist
  dieselbe Aussage, die die Startseite ohnehin zeigt (Einrichtung statt
  Anmeldung) — mehr nicht: keine Zahl, kein Name, keine Adresse.
- Jeder abgemeldete Seitenaufruf macht eine zusätzliche Anfrage. Sie läuft
  gleichlaufend mit der Sitzungsprüfung und kostet einen Indexzugriff.
- `apps/api/src/setup/**` steht auf der `PrismaService`-Positivliste in
  `eslint.config.js`. Der Eintrag ist dort begründet und eng: zwei Routen, keine
  Kennung aus einer Anfrage, nichts, was eine Antwort erreicht.
- `DEFAULT_GROUPS` und `adminGroupName()` sind aus `admin.repository.ts`
  exportiert, damit die erste Organisation dieselben drei Gruppen bekommt wie
  jede spätere. Ein Integrationstest vergleicht beide Ergebnisse Spalte für
  Spalte statt Konstante mit Konstante.

## Was dieser ADR nicht entscheidet

| Frage | Adressat | Woran man merkt, dass sie fällig ist |
|---|---|---|
| Ob die Einrichtungsseite per Umgebungsvariable **abschaltbar** sein soll (`SETUP_UI_DISABLED`) | Betrieb | Ein Betreiber fragt danach. Heute ist der Befehl die Antwort: er richtet ein, und danach ist die Seite von selbst tot. Ein Schalter wäre ein zweiter Zustand, der auf einer *leeren* Installation dieselbe Sackgasse erzeugt wie vorher. |
| ~~Ob eine Installation je einen **zweiten** Superadministrator über eine Oberfläche bekommen soll~~ — **entschieden am 2026-08-19: ja.** | Produkt | **Gebaut in [ADR-0029](0029-zweiter-superadministrator.md):** ein siebter Reiter der Systemverwaltung ernennt ein **vorhandenes** Konto über seine E-Mail-Adresse und nimmt die Ernennung zurück, hinter derselben Wache. §3, §4 und §6 dieses ADR bleiben unberührt — insbesondere die Zusage von §6: `is_superadmin` steht weiterhin in **keinem** Anfragedokument, die neue Route schreibt den Wert wörtlich im Code. Was sich ändert, ist die Aussage „über keine Route setzbar": sie gilt jetzt für jede Route außer der einen, die die Systemverwaltung dafür bekommen hat. |
| Ob `GET /api/setup` hinter dem gleichen Zähler wie die Anmeldung laufen soll, wenn die Installation eingerichtet **ist** | Backend | Eine Messung, wie oft die Route auf einer laufenden Installation wirklich gerufen wird. Solange die Antwort ein Indexzugriff ist, ist 120 die günstigere Zahl. |
| Ob der Befehl auch **weitere** Organisationen anlegen können soll | Betrieb | Sobald jemand eine Installation ohne Oberfläche einrichten will. Heute ist das ausdrücklich die Aufgabe von „+ Neue Organisation" hinter dem Superadmin-Guard. |

---

## Fortschreibung 2026-08-18: aus einer Maske wird ein Assistent

- **Status:** accepted
- **Date:** 2026-08-18
- **Ersetzt:** §1 (soweit es die *Gestalt* der Einrichtung betrifft) und §2
  (soweit es die erste Organisation betrifft). **Unberührt:** §3 (die Bedingung
  in derselben Transaktion), §4 (der Befehl), §5 (die Rate-Limits), §6 (die
  Ausnahme `is_superadmin`) und §7 (der Seed) — und ausdrücklich auch die
  Zusage, dass `POST /api/setup` **keine Sitzung ausstellt**.

### Kontext

Was §1 beschrieb, war eine Maske: Zugang, optional eine Organisation, dann ein
Neuladen. Sie richtete das ein, ohne das eine Installation nicht *startet* — und
ließ alles offen, ohne das sie nicht *arbeitet*. Wer sie durchlaufen hatte,
hatte ein Konto und sonst nichts: keine Basis-Adresse (also Links in Mails, die
ins Leere zeigen), keinen Mailserver der Instanz (also keinen Betriebsalarm),
keine Betreiberadresse (also einen Alarm ohne Empfänger). Nichts davon war
irgendwo genannt; man fand es, wenn es fehlte.

Der Nutzer hat entschieden: **führend, aber überspringbar.**

### Entscheidung

#### 1. Sieben Schritte, einer davon verbindlich

Die Einrichtung führt einmal durch **alle** Systemeinstellungen und sagt bei
jedem Schritt, *was ohne ihn nicht funktioniert*
(`apps/web/src/views/setup/steps.ts` — `consequence` ist ein **Pflichtfeld** des
Typs, damit ein neuer Schritt den Satz nicht vergessen kann):

1. **Dein Zugang** — nicht überspringbar.
2. **Basis-Adresse** — aus `window.location.origin` **vorbelegt**, sichtbar und
   bestätigungspflichtig (siehe Nr. 3).
3. **Mailserver der Instanz** — mit Testmail an Ort und Stelle.
4. **Antwortadresse und Betreiberadresse.**
5. **Benachrichtigungs-Vorlagen** — der Schritt, für den es den Schreibweg erst
   geben musste (Nr. 4).
6. **KI-Einstellungen** — mit dem Hinweis, dass die Funktion ohne sie schlicht
   abwesend ist, und einem Verweis auf `docs/kb/10-datenschutz.md` §4 statt
   einer zweiten Fassung der Vorbedingungen.
7. **Erste Organisation** — über dieselbe Maske, die „+ Neue Organisation"
   benutzt.

**Verworfen: Pflichtschritte.** Eine Installation, die man erst betreiben kann,
wenn ein Mailserver eingetragen ist, zwingt zu erfundenen Werten — und ein
erfundener SMTP-Block ist schlimmer als keiner, weil er die Warteschlange
stillstehen lässt statt sie gar nicht erst zu füllen.

#### 2. Die Sitzung entsteht durch eine gewöhnliche Anmeldung

Schritt 1 ist weiterhin **der eine geschützte `POST /api/setup`** mit der
Bedingung in derselben Transaktion und der Vorsperre (§3). Die Schritte 2 bis 7
sind ganz gewöhnliche, angemeldete Routen hinter `SuperadminGuard`. Dazwischen
liegt genau eine Frage: woher kommt die Sitzung?

**Entschieden: der Assistent meldet sich nach Schritt 1 selbst an**, über
`POST /api/auth/login`, mit den Zugangsdaten, die eine Zeile weiter oben getippt
wurden und ohnehin im Speicher des Formulars stehen (`AccessStep.tsx`).

Das ist die Änderung mit Sicherheitsbezug, und sie ist bewusst die **kleinere**
von zwei Möglichkeiten:

- **Verworfen: `POST /api/setup` stellt eine Sitzung aus.** Das wäre eine Zeile
  mehr Macht für die gefährlichste Route der Anwendung — die eine Route, die
  ohne Anmeldung ein Konto anlegt, das jede Organisation, jedes Formular und
  jede Antwort sehen darf. §2 hat das ausgeschlossen, und das Argument gilt
  unverändert.
- **Gewählt: derselbe Weg, den ein Mensch eine Sekunde später von Hand gegangen
  wäre.** Dieselbe Wache, dasselbe Rate-Limit (zehn je Minute und Adresse),
  dieselbe Argon2id-Prüfung. Ein Angreifer gewinnt daraus nichts, was er nicht
  ohnehin hätte: er müsste das Passwort kennen, das er gerade selbst gesetzt
  hätte. Und die Zusage von §2 bleibt wörtlich erhalten — *„dass die eben
  gesetzten Zugangsdaten funktionieren, ist damit auch gleich bewiesen"* —, nur
  dass der Beweis jetzt sofort geführt wird und der Assistent weitergehen kann.
  Scheitert die Anmeldung, sagt Schritt 1 das ausdrücklich und schickt zur
  Anmeldemaske; der Zugang steht dann trotzdem.

⚠️ **Die Einrichtung zerfällt dabei nicht in mehrere ungeschützte Aufrufe.** Es
gibt weiterhin genau einen Aufruf ohne Sitzung, und er ist derselbe wie vorher.

Zwei Nebenbedingungen, die aus der Bauform folgen und benannt gehören:

- Der Assistent benutzt **`login()` und nicht `useLogin()`**. Der Hook schreibt
  die Sitzung in den Query-Cache; `App.tsx` tauschte daraufhin mitten im Ablauf
  die Einrichtung gegen die angemeldete Schale aus und risse den Assistenten
  weg. Das Cookie ist gesetzt, die folgenden Schritte tragen es, und die
  Anwendung erfährt vom Sitzungswechsel am Ende durch ein volles Neuladen —
  dieselbe Ehrlichkeit, die §1 dem Neuladen schon zusprach.
- **Die erste Organisation wandert aus `POST /api/setup` heraus.** Das Feld
  `tenant` bleibt im Schema (der Befehl aus §4 benutzt es weiter), der Assistent
  schickt dort aber immer `null` und legt die Organisation in Schritt 7 über
  „+ Neue Organisation" an. Der Grund ist nicht Sparsamkeit: zwei Wege, eine
  Organisation anzulegen, wären zwei Stellen, an denen ihre Gruppen, ihre
  Vorgaben und ihre erste Administratorin entstehen — und die zweite wäre die,
  die niemand pflegt, weil man sie einmal im Leben einer Installation sieht.
  Es macht Schritt 7 zugleich unabhängig von ADR-0024 (Einladungsmail statt
  getipptem Passwort): was `CreateTenantForm` fragt, entscheidet
  `tenantCreateSchema`, und der Assistent sieht davon nichts.

#### 3. Die Basis-Adresse wird vorbelegt — und trotzdem vorgelegt

`window.location.origin` ist die einzige Angabe dieses Ablaufs, die die
Anwendung über sich selbst herausfinden kann, und sie stimmt in der
überwiegenden Zahl der Installationen. **Blind übernommen wird sie nicht:** das
Feld bleibt sichtbar, änderbar und trägt einen Satz, der sagt warum — hinter
einem Reverse-Proxy ist die Adresse, die der Browser sieht, nicht zwingend die,
unter der die Installation von außen erreichbar ist, und ein falscher Wert
erzeugt Links, die in jeder Mail ins Leere zeigen und sich nicht zurückrufen
lassen.

Vorbelegt wird außerdem nur, was **leer** ist: ein zweiter Besuch des Schritts
überschreibt keinen gespeicherten Wert mit der Adresse des Browsers.

#### 4. Der Schreibweg der Benachrichtigungs-Vorlagen — mit seinem Zähler

`system_setting.notification_templates` wurde gelesen und von **nichts**
geschrieben; `system-settings.module.ts` hielt die Bedingung fest, unter der das
aufhören darf: *wer die Route baut, bringt die Revisions-Spalte mit.* Beides ist
jetzt da:

- Migration `20260818100000_notification_templates_revision` — additiv,
  `DEFAULT 1` wie `mail_revision` und `ai_revision`.
- `GET`/`PUT /admin/system-settings/notification-templates` hinter derselben
  Wache und demselben Rate-Limit wie die beiden anderen Paare.
- Ein **eigener** Zähler und nicht der der Mailseite: drei Blöcke einer Zeile
  werden von drei Seiten gepflegt, und ein gemeinsamer Zähler beantwortete
  „jemand anderes war schneller" auch dann mit ja, wenn der andere etwas völlig
  anderes angefasst hat.
- Das Lesen ist **tolerant**, aus dem Grund, den die Mailseite ausschreibt: das
  ist der eine Ort, an dem ein unlesbares Dokument repariert werden kann, und
  ein 500 sperrte die Installation aus der Reparatur aus. Was der Bearbeiter
  dann sieht, ist die Auslieferung, und `decided: false` sagt es ihm.
- Der Reiter *Vorlagen* der Systemverwaltung ist Teil derselben Entscheidung:
  ein Text, den man genau einmal im Leben einer Installation ändern kann, ist
  kein Text, den man ändern kann.

#### 5. Die Liste offener Punkte liest den Zustand, nicht die Geschichte

Was der Assistent offenlässt, steht danach in der Systemverwaltung, bis es
erledigt ist (`apps/web/src/views/system-settings/open-items.ts`). Abgeleitet
wird sie aus den **tatsächlichen** Dokumenten — ist ein Mailserver hinterlegt?
eine Basis-Adresse? eine Betreiberadresse? gibt es eine Organisation? —, und
jeder Punkt sagt in einem Satz, was ohne ihn nicht geht.

**Verworfen: ein „Schritt übersprungen"-Merker.** Er liefe in beide Richtungen
auseinander: wer den Mailserver überspringt und ihn zwei Minuten später im
Reiter einträgt, hätte einen offenen Punkt, den es nicht gibt; wer ihn im
Assistenten setzt und später entfernt, hätte keinen, obwohl der Alarm niemanden
mehr erreicht. Ein Merker beschreibt eine Vergangenheit; gefragt ist die
Gegenwart.

Der Maßstab ist **ein gültiger Endzustand oder keiner**. Die Antwortadresse,
die KI und die Vorlagen stehen deshalb nicht auf der Liste, obwohl der Assistent
sie anbietet: ohne sie funktioniert alles, nur eben anders. Eine Liste, auf der
Punkte stehen, die ein gültiger Endzustand sind, ist eine Liste, die man
wegsieht — und dann steht der Mailserver mit darauf.

**Fortschreibung 2026-08-19 (ADR-0029): geprüft wird der Maßstab über zwei
Fragen, und ein Punkt braucht ein Ja zu einer davon.**

1. **Funktioniert ohne ihn etwas nicht?** Der Regelfall, und der, den die
   Punkte dieses ADR beantworten: ohne Basis-Adresse zeigen die Links in der
   Mail nirgendwohin.
2. **Wäre ein Ausfall ohne ihn nicht mehr behebbar?** Alles funktioniert — bis
   zu dem einen Moment, dessen Rückweg dieser Zustand war, und ab dann
   funktioniert nichts mehr, und keine Seite dieser Anwendung ist noch
   erreichbar, um es zu richten.

Die zweite Frage ist die jüngere und **absichtlich eng gehalten**, sonst ist sie
keine Regel: sie fragt nach dem **letzten Weg zurück in die Anwendung**, nicht
nach „riskant", nicht nach „unangenehm", nicht nach „ein zweiter wäre schöner".
Genau ein Punkt beantwortet sie heute (`single-superadmin`, ADR-0029); wer einen
zweiten hinzufügt, benennt den Ausfall, dessen Rückweg er ist, und warum dieser
Weg an jeder Oberfläche vorbeiführt.

Das gilt für die Liste der **Installation**. Die Liste einer Organisation
(ADR-0025) kennt bis heute keinen Fall des zweiten Zweigs: eine Organisation
ohne Administrator kann die Systemverwaltung wieder mit einem versorgen — der
Weg zurück führt dort also nicht an jeder Oberfläche vorbei.

#### 6. Ein Gerüst, kein Assistent — `apps/web/src/wizard/`

Der Rahmen (`WizardFrame`) liegt in einem eigenen Verzeichnis und weiß von
Routen, Speichern und Systemeinstellungen nichts. Er trägt, was **jeder**
Assistent gleich machen muss: die Schrittliste, die Position als **Text**
(„Schritt 3 von 7"), die Zustände als **Wort** statt als Farbe, die Fokusführung
beim Schrittwechsel und die drei Schaltflächen in immer derselben Anordnung.

Der Grund ist benannt: es soll einen **zweiten** Assistenten geben, den einer
frisch angelegten Organisation. Ein Gerüst, das auch noch wüsste, wie
gespeichert wird, wäre keins — es wäre der erste Assistent mit einem Parameter
für den zweiten.

#### 7. Zwei Ausreißer sind auf die gemeinsame Bauform gezogen

`setup-view.css` ist **weg**: die Felder eines Schritts sind die gemeinsamen
Bausteine aus `settings-view.css`, damit ein Schritt aussieht wie die
Einstellung, zu der er führt. Und der Reiter *KI* benutzt jetzt
`SettingsSectionCard`-Bauform, `SelectSetting`/`TextSetting`/`ToggleSetting`,
einen Entwurf über `useServerDraft` und `SettingsSaveBar` statt eigener Klassen,
eigener Auswahlfelder, fünf loser `useState` und eines eigenen
Speichern-Knopfes.

⚠️ **Eine Verhaltensänderung kommt damit mit, und sie ist beabsichtigt:** die
Speicherleiste sperrt „Speichern", solange nichts geändert ist, und sagt
„Gespeichert"/„Nicht gespeichert" — wie jede andere Einstellungsseite. Vorher
ging der Knopf immer und schickte auch dann eine Runde, wenn sie nichts zu sagen
hatte.

### Konsequenzen

- Eine frisch eingerichtete Installation ist **arbeitsfähig oder weiß, was ihr
  fehlt** — beides, nicht eines von beiden.
- Es gibt weiterhin genau **eine** Route ohne Sitzung, die schreibt, und sie ist
  unverändert. Neu ist eine gewöhnliche Anmeldung unmittelbar danach.
- `system_setting` hat einen dritten Zähler. Wer eine vierte Gruppe von Spalten
  hinzufügt, bringt ihren eigenen mit — die Begründung steht an der Spalte.
- Der Reiter *KI* verhält sich beim Speichern wie die anderen. Wer die alte
  Bauform sucht, findet sie in der Fassung vor dem 2026-08-18.
- **Folgearbeit, benannt und inzwischen erledigt:** der Assistent einer neu
  angelegten Organisation. Er baut auf `apps/web/src/wizard/` auf; sein
  Endbildschirm ist hier schon angekündigt (`SetupComplete`), damit niemand die
  Organisation für fertig eingerichtet hält. Gebaut wurde er in
  [ADR-0025](0025-ersteinrichtung-einer-organisation.md) — acht Schritte, alle
  überspringbar, mit derselben Liste offener Punkte auf dem Dashboard der
  Organisation. Das Gerüst hat dabei **ein** Feld dazubekommen
  (`standalone`), sonst nichts.

### Was diese Fortschreibung nicht entscheidet

| Frage | Adressat | Woran man merkt, dass sie fällig ist |
|---|---|---|
| ~~Ob der Assistent **wiederaufnehmbar** sein soll~~ **Entschieden am 2026-08-19: nein.** Der Ersatz trägt, und ein Fortschritts-Merker wäre eine zweite Wahrheit über denselben Sachverhalt — die Liste offener Punkte ist aus dem *tatsächlichen* Zustand abgeleitet (Nr. 5) und läuft deshalb nie auseinander. | erledigt | Ein Betreiber bricht mittendrin ab. Heute ist der Ersatz vollwertig: alle Schritte außer dem ersten sind ganz normale Einstellungsseiten, und was fehlt, steht in der Liste offener Punkte. Ein gespeicherter Fortschritt wäre der Merker, den Nr. 5 gerade ausschließt. |
| ~~Ob die Liste offener Punkte auch **außerhalb** der Systemverwaltung erscheinen soll~~ **Entschieden am 2026-08-19: nein.** Sie betrifft allein den Superadministrator, und der geht ohnehin in die Systemverwaltung; die Liste einer *Organisation* steht bereits auf deren Dashboard. Mehr Sichtbarkeit hieße hier vor allem mehr Rauschen für alle anderen — genau das, was der Satz über die Zeile meint, die überall steht und überall überlesen wird. | erledigt | Jemand richtet ein und sieht die Systemverwaltung wochenlang nicht. Dagegen steht, dass eine Zeile, die überall steht, überall überlesen wird. |
| Ob Schritt 3 die Testmail **erzwingen** soll, bevor er als erledigt gilt | Betrieb | Eine Installation mit einem Mailserver, der nie eine Mail angenommen hat. Heute ist die Testmail angeboten und freiwillig — ein Zwang machte aus einem Einrichtungsschritt eine Fehlersuche. |

---

## Nachtrag 2026-08-18: der Assistent bleibt bis zum Ende stehen

- **Status:** accepted
- **Date:** 2026-08-18
- **Betrifft:** die *Gestalt* des Ablaufs. **Unberührt:** §3 (die Bedingung in
  derselben Transaktion), §5 (die Rate-Limits), §6 (`is_superadmin`), Nr. 2 der
  Fortschreibung (`POST /api/setup` stellt keine Sitzung aus) und Nr. 5 (die
  Liste offener Punkte liest den Zustand, nicht die Geschichte).

### Der Befund

Der Assistent kündigte acht Schritte an — sieben aus der Fortschreibung plus
*Rechtliche Angaben* aus [ADR-0028](0028-rechtstexte.md) — und war **ab
Schritt 3 nicht mehr erreichbar**: nach „Überspringen" auf Schritt 2 stand die
Systemverwaltung da, ohne dass jemand etwas abgebrochen hätte. Gemessen im
Browser am 2026-08-18.

### Was die Messung ergeben hat — und was nicht

Der naheliegende Verdacht war, dass `GET /api/setup` nach Schritt 1
`setupRequired: false` antwortet und der Einrichtungsansicht damit ihre
Grundlage nimmt. **Das ist widerlegt.** Die Route wird genau **einmal je
Seitenaufruf** gefragt: `useSetupState` hält `staleTime: Infinity`, und die
Antwort wird nirgends verworfen (`apps/web/src/api/setup.ts` schreibt aus, warum
`useRunSetup` bewusst kein `onSuccess` hat).

Weggerissen hat den Assistenten die **Sitzungsfrage**. Schritt 1 meldet sich
unmittelbar nach `POST /api/setup` an (Fortschreibung Nr. 2), und ab diesem
Moment ist die 401 von `GET /api/auth/me` überholt. Es genügt, dass irgendwer
sie noch einmal stellt — und Schritt 3 tut genau das: `MailServerStep` ruft
`useSession()`, um die eigene Adresse für die Testmail anzubieten. Das ist ein
**zweiter Beobachter** derselben Abfrage, deren Antwort ohne `staleTime` sofort
veraltet ist, also ein `refetchOnMount`. Die frische Antwort trägt den eben
angelegten Superadministrator, und `App.tsx` schaltete an der Zeile
`session.data === null` auf die angemeldete Schale um. Schritt 8 hätte dasselbe
getan, dort sogar ausdrücklich: `useCreateTenant` verwirft die Sitzungsabfrage,
damit die frische Mitgliedschaft ankommt.

⚠️ Die Fortschreibung hatte diese Falle für `useLogin()` **benannt** („`App.tsx`
tauschte daraufhin mitten im Ablauf die Einrichtung gegen die angemeldete Schale
aus und risse den Assistenten weg") und für den Cache entschärft. Was sie nicht
sah: es braucht den Hook gar nicht. Ein gewöhnliches `useSession()` in einem
Schritt reicht.

### Die Entscheidung: einmal beim Betreten, nicht bei jeder Abfrage

`App.tsx` hält für die Dauer eines Durchlaufs fest, **dass** einer läuft, und
zeigt den Assistenten, solange er läuft — auch wenn die Installation formal
längst eingerichtet ist. Angeschaltet wird diese Sperre ausschließlich aus der
Antwort des Servers, die es dafür schon gab: `GET /api/setup` hat
`setupRequired: true` gesagt, die Installation hatte in diesem Moment also kein
einziges Konto. Sie endet mit dem vollen Neuladen in `SetupComplete`.

**Verworfen: „kein Schritt darf die Sitzung befragen".** Das wäre eine Regel,
die niemand einhalten kann, und sie widerspräche der Bauform: die Schritte
zeigen absichtlich dieselben Karten wie die Systemverwaltung, und die fragen.
Sie wäre außerdem an der falschen Stelle scharf — der nächste Schritt, der eine
Karte wiederverwendet, brächte den Fehler zurück, ohne dass jemand etwas falsch
gemacht hätte.

**Verworfen: den Assistenten auf die erreichbaren Schritte kürzen.** Das war die
zweite Möglichkeit, die der Befund offenließ, und der Nutzer hat gegen sie
entschieden: was die Fortschreibung beschreibt, ist ein Ablauf, der einmal durch
**alle** Systemeinstellungen führt. Eine Zählung „von 2" hätte den Widerspruch
beseitigt, indem sie die Zusage aufgibt.

### Was dabei nicht aufgegeben wurde

- **Die Einrichtungsseite bleibt für eine eingerichtete Installation ohne
  Sitzung unerreichbar.** Der Server sagt dort `setupRequired: false`, die Sperre
  geht nie an. Sie ist eine Sperre *für* eine bereits erteilte Auskunft, keine
  zweite Quelle daneben — der Browser behauptet nichts, was der Server nicht
  gesagt hat.
- **`POST /api/setup` ist unverändert**: dieselbe Bedingung („null Zeilen in
  `user`") in derselben Transaktion, dieselbe Vorsperre, dieselbe 404 danach
  (§3). Es gibt weiterhin genau **einen** schreibenden Aufruf ohne Sitzung.
- **Kein „übersprungen"-Merker.** Die Liste offener Punkte bleibt aus dem
  tatsächlichen Zustand abgeleitet (Nr. 5), und der Assistent bleibt
  **nicht** wiederaufnehmbar — beides ist am 2026-08-19 ausdrücklich so
  entschieden worden (siehe Tabelle oben). Die Sperre merkt sich nichts über
  einen Seitenaufruf hinaus: sie ist Zustand einer Komponente, nichts im
  Speicher des Browsers und nichts in der Datenbank.
- **Überspringbar bleibt jeder Schritt außer dem ersten**, und niemand wird
  festgehalten: ein Neuladen mitten im Durchlauf landet in der angemeldeten
  Anwendung, denn die Sitzung aus Schritt 1 steht.

### Belegt durch

- `apps/web/src/App.test.tsx` — der Assistent bleibt nach Schritt 1 stehen (der
  Fall, den `SetupView.test.tsx` nicht sehen kann: dort hängt die Ansicht nicht
  unter `App`), und die Gegenrichtung: eine eingerichtete Installation bekommt
  ihn weder ohne noch mit Sitzung.
- `e2e/durchlauf-erstinbetriebnahme.spec.ts` — der ganze Weg im Browser:
  Schritt 1 anlegen, Schritt 2 speichern, die Schritte 3 bis 8 überspringen
  (mit einer Zusicherung je Schritt, dass es „Überspringen" dort überhaupt
  gibt), Abschlussbildschirm, und nach „Zur Anwendung" die angemeldete
  Anwendung.

## Fortschreibung 2026-08-21 (Review-Runde 3)

### Die Schrittliste ist eine **Navigation**

*„Einrichtungsassistent: Man kann oben über die Breadcrumbs nicht navigieren.
Das wäre intuitiv."* — der Befund traf einen Satz, der wörtlich im Rahmen
stand: „A navigation this is **not**". Er war einmal richtig gemeint (Schritt
1 legt das Konto an, auf das alle folgenden angewiesen sind) und im Ergebnis
falsch: alle **übrigen** Schritte sind gewöhnliche, angemeldete
Systemeinstellungen, die sich in jeder Reihenfolge und beliebig oft aufrufen
lassen. Wer in Schritt 6 merkte, dass die Adresse aus Schritt 4 falsch ist,
musste dreimal „Zurück" und danach dreimal „Weiter" drücken.

Jeder Schritt trägt jetzt ein `reachable`, und der Rahmen macht daraus eine
Schaltfläche. **Pflichtfeld und kein `?`**: die eine Ausnahme dieser Anwendung
— der nicht wiederholbare erste Schritt — darf nicht die Vorgabe eines Feldes
sein, das man vergessen kann. Ein Sprung speichert nicht; wer einen Schritt
abschließen will, drückt weiterhin „Speichern und weiter".

### „Speichern" ohne Weiterzugehen — im Schritt *Mailserver*

*„Erste Einrichtung: Testmail senden kann nicht geklickt werden, da ja
Mailserver-Sachen noch nicht gespeichert sind."* Die Testmail prüft, was
**gespeichert** ist — das ist richtig und bleibt so —, aber der einzige Weg zu
speichern hieß „Speichern und weiter" und führte damit von dem Knopf weg, den
man drücken wollte. Ein Schritt, der eine Probe anbietet und den Zustand für
die Probe erst beim Verlassen herstellt, bietet sie nicht wirklich an.

Der Rahmen kennt deshalb eine zweite Handlung (`secondary`), und **nur der
Mailserver-Schritt** setzt sie: ein vierter Knopf an jedem Schritt wäre die
stille Antwort auf einen Befund über einen einzigen.

Zusammen mit der Fortschreibung von ADR-0013 (Review-Runde 3 Nr. 12 — die
Systemtestmail braucht keine Organisation mehr) ist der Mailserver damit dort
prüfbar, wo man ihn einrichtet. Das war der Sinn dieses Schrittes.

### Die Rechtstexte nennen die Barrierefreiheit als freiwillig

Der Satz des Schrittes *Rechtliche Angaben* führte Impressum,
Datenschutzerklärung und Erklärung zur Barrierefreiheit als eine Reihe auf.
Zwei davon treffen jeden Betreiber, die dritte nicht — siehe die
Fortschreibung von [ADR-0028](0028-rechtstexte.md).

> **Überholt seit Review-Runde 4 Nr. 4:** die Erklärung zur Barrierefreiheit
> ist ersatzlos gestrichen. Der Schritt nennt nur noch die beiden Seiten, die
> jeden Betreiber treffen.

