# 8. Test-Datenbanken kommen aus Testcontainers — oder aus einem laufenden Server

- **Status:** accepted
- **Date:** 2026-07-26

## Context

Ein Integrationstest gegen echtes PostgreSQL ist vorgeschrieben, der
den Zugriff über die Tenant-Grenze **scheitern** sieht; als Beschaffungsweg für
die Datenbank ist Testcontainers vorgesehen. Testcontainers setzt einen erreichbaren
Docker-Daemon voraus.

In der Entwicklungsumgebung dieses Repos gibt es keinen. Gemessen, nicht
vermutet: `/var/run/docker.sock` existiert nicht, der Docker-Client ist zwar
installiert, `docker version` scheitert beim Verbindungsaufbau zur API. Es ist
dieselbe Umgebung, in der schon die Anforderung offenbleiben musste, weil der
Agent-Proxy die Blob-CDNs der Container-Registries mit `403` abweist.

Damit stehen drei Wege offen, und zwei davon sind schlecht:

1. **Den Test aussetzen, bis eine Umgebung mit Docker da ist.** Dann entsteht die
   Tenant-Isolation ohne den Test, der sie belegt — und der Test
   wird später gegen fertigen Code geschrieben, statt ihn zu treiben. Genau der
   Fall, vor dem ADR-0007 warnt: ein Nachweis, der den Ist-Zustand bestätigt,
   statt ihn zu prüfen.
2. **Auf eine In-Memory- oder SQLite-Ersatzdatenbank ausweichen.** Das ist der
   gefährlichste Weg. Tenant-Isolation hängt an Verhalten, das nur echtes
   PostgreSQL zeigt (Constraints, Transaktionsisolation, später Row-Level
   Security und JSONB). Ein grüner Test auf einem anderen Datenbanksystem
   belegt an einer Sicherheitsgrenze nichts.
3. **Die Datenbank austauschbar beschaffen** — echtes PostgreSQL bleibt Pflicht,
   nur die Herkunft darf variieren.

Ein echter PostgreSQL-Server steht in dieser Umgebung zur Verfügung (16.14, per
TCP unter der `DATABASE_URL` aus `.env.example`, Rolle mit `CREATEDB`).

## Decision

Test-Datenbanken werden über **einen** Provider bezogen —
`apps/api/test/database/test-database.ts`, Einstiegspunkt
`acquireTestDatabase()` — der zwei Wege hinter derselben API kapselt:

- **Testcontainers ist der Standardweg.** Der Provider fragt zur Laufzeit die
  Container-Runtime selbst (`getContainerRuntimeClient()` aus `testcontainers`,
  das die Socket-Kandidaten durchgeht und den Daemon anspricht). Geprüft wird
  eine *Antwort*, nicht eine gesetzte `DOCKER_HOST`-Variable: eine Variable, die
  auf einen toten Daemon zeigt, darf nicht als „Testcontainers lief" durchgehen.
  Das Image ist `postgres:17-alpine`, dasselbe wie im `db`-Service der
  `docker-compose.yml`.
- **Antwortet keine Runtime**, kommt der Server aus `TEST_DATABASE_URL`
  (Rückfall: `DATABASE_URL`).

**Die Datenbank entsteht auf beiden Wegen durch denselben Code.** Naheliegend
wäre, auf dem Testcontainers-Weg einfach die Datenbank des Containers zu
nehmen. Das ist falsch: `@testcontainers/postgresql` vergibt den festen Namen
`test` (`database = "test"` in `postgresql-container.js`), also hießen zwei
parallel gestartete Container beide gleich, und jede Zusicherung über
Eindeutigkeit von Namen wäre auf diesem Weg unhaltbar. Deshalb legt auch der
Container-Weg seine Datenbank über `createDatabaseIn()` an und erbt den
erzeugten Namen `formsache_test_<Zeitstempel>_<18 hex>`. Beim Freigeben genügt dort
das Stoppen des Containers; auf dem externen Weg folgt
`DROP DATABASE … WITH (FORCE)`.

**Isolation ist eine Datenbankgrenze, keine Konvention.** Vitest führt
Testdateien parallel in eigenen Workern aus; ein gemeinsames Schema würde
Zeilen einer Datei in einer anderen sichtbar machen. Weil PostgreSQL keine
Abfragen über Datenbankgrenzen hinweg zulässt, ist die Trennung hart. Der
zufällige Namensanteil — nicht die Worker-Nummer — verhindert außerdem
Kollisionen zwischen zwei Checkouts auf demselben Server. Der Provider prüft die
Grenze zusätzlich selbst: `requireOwnDatabase()` bricht ab, wenn die
ausgelieferte URL nicht die eben erzeugte Datenbank adressiert — ein Fehler beim
Zusammenbauen der URL würde sonst allen Aufrufern die geteilte Basis-Datenbank
geben, und der Isolationstest liefe ins Leere.

**Aufgeräumt wird beim Anlegen, nicht beim Beenden.** Ein hart abgeschossener
Lauf (`SIGKILL`, abgestürzter CI-Runner) erreicht `release()` nie, und kein
Signal-Handler ändert daran etwas. Deshalb trägt jeder Name einen Zeitstempel,
und vor jedem `CREATE DATABASE` räumt der Provider ältere `formsache_test_%`-Reste ab.
Zwei Bedingungen müssen dafür **beide** zutreffen: älter als zwei Stunden und
keine Verbindung in `pg_stat_activity`. Die zwei Stunden liegen weit über jedem
plausiblen Testlauf — die Alternative wäre, einem parallelen Worker zwischen
`CREATE DATABASE` und erster Verbindung den Boden wegzuziehen.

**Der gewählte Weg wird angekündigt.** Jeder Aufruf schreibt eine Zeile
`[test-database] strategy=… server=… database=…` und, für den externen Weg, den
Grund. `server=` nennt die **gemessene** Version, nicht die erwartete. Damit die
Zeile auch dort ankommt, wo sie gebraucht wird, steht in der Vitest-Konfiguration
`disableConsoleIntercept: true`: Vitest puffert `console`-Ausgaben sonst und der
Vorgabe-Reporter verwirft sie außerhalb eines TTY wieder — gemessen 0 statt 14
Zeilen, also ausgerechnet in der CI unsichtbar.

**Der Weg ist erzwingbar.** `TEST_DATABASE_STRATEGY` kennt `auto` (Vorgabe),
`testcontainers` und `external`. Die CI setzt `testcontainers` und bekommt bei
fehlendem Daemon einen Fehler statt eines stillen Ausweichens — die
Ankündigungszeile allein würde in einem CI-Log untergehen. Diese Regel steckt in
`resolveStrategy(preference, runtimeAvailable)`, einer reinen Funktion: sie ist
die Zusage, auf der dieses ADR und die CI-Empfehlung ruhen, und muss deshalb
**ohne** Docker beweisbar sein.

**Migrationen laufen über eine Naht, nicht über Nachbau.**
`applyMigrations(url)` ruft `prisma migrate deploy` gegen die frisch erzeugte
URL auf — bewusst `migrate deploy` und nicht `db push`, damit die Testdatenbank
so entsteht wie eine produktive. Solange
`apps/api/prisma/schema.prisma` fehlt — vor der ersten Anlage der
Datenbank-Anbindung —, meldet der Schritt `skipped` **mit Begründung**; ein
Überspringen kann so nie mit einem erfolgreichen Migrationslauf verwechselt
werden. Ein *nicht auffindbarer* Paket-Wurzelordner ist dagegen kein
`skipped`, sondern ein Fehler: als Auslassung gemeldet, liefen von da an
sämtliche Integrationstests gegen eine unmigrierte Datenbank, mit einem Wort
im Protokoll als einziger Spur.

## Consequences

- **Beide Wege fahren dieselbe Suite.** Es gibt keine „Docker-Tests" und keine
  Ersatzvariante; der Isolationstest wird in beiden Umgebungen von derselben Datei geprüft.
- **Die Postgres-Version kann abweichen — und das ist die wichtigste
  Einschränkung.** Der Testcontainers-Weg fährt `postgres:17-alpine`, also
  exakt das, was `docker-compose.yml` startet. Der externe Weg fährt, was auf
  dem Host installiert ist; hier ist das **PostgreSQL 16.14**. Für
  Tenant-Isolation über `WHERE tenant_id = …`, Fremdschlüssel und
  Transaktionen ist der Unterschied ohne Belang — beide Versionen verhalten
  sich dort gleich. Sobald jedoch versionsabhängige Merkmale ins Spiel kommen
  (Row-Level Security in Verbindung mit neueren Planer-Eigenschaften,
  JSONB-Funktionen aus 17, `MERGE … RETURNING`), belegt ein grüner Lauf auf 16
  nichts über 17. Deshalb: der externe Weg ist ein **gleichwertiger Ersatz für
  die Beschaffung**, nicht für die Zielversion. Die Ankündigungszeile nennt die
  tatsächliche Serverversion, damit dieser Unterschied im Protokoll steht und
  nicht in der Erinnerung. **Verbindlich:** die CI setzt
  `TEST_DATABASE_STRATEGY=testcontainers`, damit jeder Merge auf der
  Produktionsversion geprüft ist.
- **Ein Container je Aufruf** auf dem Testcontainers-Weg. Das ist langsamer als
  ein geteilter Container mit mehreren Datenbanken, aber es macht die Isolation
  trivial richtig. Wenn die Laufzeit stört, ist das Zusammenlegen eine spätere
  Optimierung — mit dem Isolationsnachweis aus dem Selbsttest als Netz.
- **Der externe Weg braucht Rechte.** Die Rolle muss `CREATEDB` haben und
  Datenbanken löschen dürfen. Auf einem geteilten Server ist das eine bewusste
  Entscheidung; die Wegwerf-Datenbanken tragen deshalb einen erkennbaren
  Präfix.
- **Neue Abhängigkeiten in `apps/api` (nur `devDependencies`):**
  `testcontainers` und `@testcontainers/postgresql` für den Standardweg, `pg`
  und `@types/pg` für Anlegen/Löschen und für den Selbsttest ohne Prisma. Sie
  gehören nicht in den `catalog:`, weil sie nur ein Workspace nutzt. Die
  Installationsskripte von `ssh2`, `cpu-features` und `protobufjs` bleiben
  gesperrt (`onlyBuiltDependencies`, ADR-0006) — sie liefern optionale
  native Beschleunigung, die hier niemand braucht.
- **Der Provider hat einen eigenen Test**
  (`test/database/test-database.spec.ts`), der nicht „grün" behauptet, sondern
  den verbotenen Fall scheitern sieht: In Datenbank A entsteht eine Tabelle mit
  einer Zeile, in Datenbank B muss dieselbe Abfrage mit `42P01`
  (*undefined_table*) fehlschlagen — und auch mit gleichnamiger Tabelle bleibt B
  leer. Ohne diesen Test wäre der Provider selbst die ungeprüfte Stelle, auf der
  die Tenant-Isolation steht.
- **Die Regeln sind vom Server entkoppelt geprüft.**
  `test/database/test-database-rules.spec.ts` beweist ohne jede Infrastruktur,
  was der Provider zusagt: die Strategie-Matrix samt hartem Fehler bei
  erzwungenem Testcontainers ohne Daemon, die Rückfallkette
  `TEST_DATABASE_URL` → `DATABASE_URL` → Fehler, die Ablehnung einer Basis-URL
  ohne `postgres`-Schema und die Weigerung, die Basis-Datenbank auszuliefern.
  Diese Tests laufen auf jeder Maschine — gerade dort, wo Docker fehlt.
- **Der `SIGKILL`-Fall ist gemildert, nicht gelöst.** Ein abgeschossener Lauf
  hinterlässt seine Datenbank; sie verschwindet erst beim nächsten Anlegen,
  frühestens zwei Stunden später. Das verhindert monotones Wachstum, nicht
  jedoch kurzzeitige Reste. Wer sofort aufräumen will, dropt sie von Hand — der
  Präfix macht sie auffindbar.
- **`test/` liegt außerhalb von `src/`**, damit die Testinfrastruktur nicht in
  `tsconfig.build.json` und damit nicht ins Laufzeit-Image gerät.

## Referenzen

- [ADR-0006](0006-pnpm-workspaces.md) — pnpm-Workspaces, `catalog:`,
  gesperrte Installationsskripte.
- [ADR-0007](0007-shared-package-consumption.md) — warum ein Test, der gegen
  den falschen Stand läuft, gefährlicher ist als kein Test.
- [`docs/kb/04-build-run.md`](../kb/04-build-run.md) — Toolchain-Fallstricke.
- `CONTRIBUTING.md` — jede Isolationsregel braucht einen Test,
  der den unerlaubten Zugriff scheitern sieht.

## Welchen Weg die CI fährt

Die CI fährt die Hauptsuite über den **externen** Weg (`postgres:17-alpine` als
Service-Container), nicht über Testcontainers. Grund: der Testcontainers-Weg
startet **je `acquireTestDatabase()`-Aufruf einen eigenen Container** — 28
Aufrufe in 27 Dateien —, und das ist der Löwenanteil der gemessenen ~5 Minuten
des `test`-Jobs. Der externe Weg legt weiterhin je Aufruf eine eigene
Wegwerf-Datenbank an (`createDatabaseIn()`, `DROP DATABASE … WITH (FORCE)` beim
Freigeben) — dieselbe Grenze, über die die Isolation der parallelen
Vitest-Worker läuft. An der Zusage dieses ADRs („beide Wege fahren dieselbe
Suite") ändert das nichts; es legt nur fest, *welcher* Weg in der CI die volle
Suite fährt.

Damit der Testcontainers-Weg nicht unbeobachtet verrottet — eine
Entwicklungsumgebung ohne Docker-Daemon merkt einen kaputten Pfad nie —, hat
der `test`-Job einen eigenen, zusätzlichen Schritt „the Testcontainers provider
still works (ADR-0008)", der **nur** `test/database/test-database.spec.ts` mit
`TEST_DATABASE_STRATEGY=testcontainers` fährt. Das ist der einzige Ort in der
ganzen Pipeline, an dem noch ein Docker-Daemon für einen Test gebraucht wird.

Details und die gemessenen Zahlen: `.github/workflows/ci.yml` (Job `test`).
