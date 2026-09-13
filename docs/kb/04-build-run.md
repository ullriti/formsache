# Bauen und starten

- [Bauen und starten](#bauen-und-starten)
  - [Voraussetzungen](#voraussetzungen)
  - [Von git clone bis zur Anmeldung — mit Containern](#von-git-clone-bis-zur-anmeldung--mit-containern)
  - [Entwicklungsumgebung ohne Container](#entwicklungsumgebung-ohne-container)
  - [Von einem anderen Gerät im Netz zugreifen](#von-einem-anderen-gerät-im-netz-zugreifen)
  - [Die beiden Vorlagen für die .env](#die-beiden-vorlagen-für-die-env)
  - [dev-setup.sh gehört hinter jedes git pull](#dev-setupsh-gehört-hinter-jedes-git-pull)
  - [Die Basis-Adresse steht in der Datenbank](#die-basis-adresse-steht-in-der-datenbank)
  - [Postgres ohne Docker](#postgres-ohne-docker)
  - [Testdatenbanken](#testdatenbanken)
  - [Prüfbefehle](#prüfbefehle)
  - [pnpm e2e](#pnpm-e2e)
  - [Die Pipeline](#die-pipeline)

Für den Betrieb einer Produktivinstallation: [`09-betrieb.md`](09-betrieb.md).

## Voraussetzungen

| Weg | Braucht |
|---|---|
| Container-Stack | Docker und Docker Compose — sonst nichts |
| Entwicklung (`pnpm dev`) | Node 22, `corepack enable` (pinnt pnpm), ein erreichbares PostgreSQL 17 |

## Von git clone bis zur Anmeldung — mit Containern

```bash
git clone https://github.com/ullriti/formsache.git
cd formsache
./scripts/dev-setup.sh                      # .env + Schlüssel, nie committen
docker compose up -d --build                # db → migrate → api → web
docker compose run --rm migrate db seed     # Entwicklungskonten
```

Anwendung: <http://127.0.0.1:8080>, Anmeldung mit `SEED_ADMIN_EMAIL` und
`SEED_ADMIN_PASSWORD` aus `.env`.

- **Die Reihenfolge steht in `docker-compose.yml`.** `api` wartet, bis `migrate`
  erfolgreich beendet ist, `web` auf eine gesunde `api`. `docker compose up -d db`
  bringt weiterhin nur die Datenbank hoch.
- **Migrationen laufen im eigenen `migrate`-Image**, dessen Einstiegspunkt die
  Prisma-CLI ist — `docker compose run --rm migrate db seed` ist deshalb
  `prisma db seed`. Das Laufzeit-Image der API trägt keine Prisma-CLI.
- **Vier Stufen, nicht drei** (Review-Runde 4 Nr. 2, „Image Size reduzieren").
  `deps` installiert, `build` übersetzt, **`deploy`** schnürt den
  auszuliefernden Baum und räumt ihn aus, `runtime` bekommt nur diesen Baum.
  `migrate` hängt weiterhin an `build` und **nicht** an `deploy` — so trägt das
  Migrations-Image den ausgelieferten Baum nicht ein zweites Mal mit sich
  herum. Was `deploy` wegwirft und warum jede Zeile davon nachgelesen ist,
  steht ausführlich im `apps/api/Dockerfile`; das Größte sind die
  WebAssembly-Abfrage-Compiler für MySQL, SQLite, SQL Server und CockroachDB,
  die eine PostgreSQL-Installation nie lädt.
  ⚠️ **Die Ersparnis ist hier nicht gemessen**: die Umstellung entstand in
  einer Umgebung ohne Docker-Daemon. Die Auswahl ist aus den Paketen selbst
  begründet, nicht aus einem `docker images`-Vergleich — wer als Nächstes
  einen Bau macht, trägt die Zahlen bitte hier nach.
- **`web` ist der Frontdoor, `api` hat keinen veröffentlichten Port.** nginx
  liefert die Oberfläche aus und reicht `/api` **ohne Rewrite** weiter; damit
  sind Browser und API unter einer Herkunft, was das Session-Cookie verlangt.
- **`NODE_ENV` kommt aus der `.env`.** `.env.example` setzt `development`, und
  nur deshalb funktioniert die Anmeldung über plain http: mit `production`
  bekommt das Session-Cookie `Secure` und heißt `__Host-formsache_session`.
  Ausdrücklich entscheiden lässt sich das über `SESSION_COOKIE_SECURE` —
  `NODE_ENV` ist nur die Vorgabe. Ein Wechsel des Wertes wechselt den
  Cookie-Namen und meldet alle Browser ab. Welche Fassung gilt, schreibt die API
  beim Start in eine Zeile (`Session cookie: …`).
- **Der Seed ist ein Werkzeug der Entwicklung.** Der erste Zugang einer
  Produktivinstallation entsteht anders ([`09-betrieb.md`](09-betrieb.md)).

## Entwicklungsumgebung ohne Container

```bash
corepack enable
pnpm install --frozen-lockfile
./scripts/dev-setup.sh                            # .env + Schlüssel
docker compose up -d db                           # oder ein lokales Postgres
pnpm --filter @formsache/api exec prisma migrate deploy
pnpm --filter @formsache/api seed                 # Beispieldaten und Konten
pnpm --filter @formsache/api dev                  # API auf :3000
pnpm --filter @formsache/web dev                  # Web auf :5173, /api wird durchgereicht
```

Anwendung: <http://127.0.0.1:5173>. Der Container-Stack darf daneben laufen — er
hängt an `APP_PORT` (8080), teilt sich mit dieser Umgebung aber dieselbe
Datenbank.

Zwei Fallen beim Start der Datenbank; beide melden sich als
`password authentication failed for user "formsache"`:

| Ursache | Erkennen | Abhilfe |
|---|---|---|
| Ein lokales Postgres belegt 5432 | `ss -lntp \| grep 5432` zeigt keinen `docker-proxy` | Host-Dienst stoppen **oder** `POSTGRES_PORT` in `.env` ändern und in allen URLs mitziehen |
| Altes `db-data`-Volume mit altem Passwort | im Log: `Database directory appears to contain a database; Skipping initialization` | `docker compose down -v` (löscht die Entwicklungsdaten), dann neu hoch |

Die Gegenprobe, die beide Fälle trennt — geht es von innen?

```bash
docker compose exec -T db psql -U formsache -d formsache -c 'select current_user'
```

## Von einem anderen Gerät im Netz zugreifen

Ein Handy im gleichen WLAN, der Rechner der Kollegin: beides braucht zwei
Dinge, und ohne das zweite sieht es aus wie ein Anmeldefehler.

**1. Der Dienst muss auf der eigenen Adresse annehmen.** In der Vorgabe binden
beide Wege auf `127.0.0.1` — von außen ist da nichts.

| Weg | Was zu tun ist |
|---|---|
| Container-Stack | `APP_BIND` in der `.env` auf die eigene Adresse (etwa `192.168.1.10`) oder `0.0.0.0`, dann `docker compose up -d web` |
| `pnpm dev` | `pnpm --filter @formsache/web dev --host 192.168.1.10` — das Flag übersteuert die Bindung in `apps/web/vite.config.ts`, die absichtlich auf `127.0.0.1` steht (Playwright fragt genau diese Adresse ab) |

Die API selbst nimmt schon auf allen Adressen an; sie steht hinter dem
Frontdoor bzw. hinter dem `/api`-Durchgang von Vite und braucht nichts.

**2. Das Sitzungs-Cookie darf kein `Secure` tragen.** Über `http://localhost`
nimmt ein Browser ein `Secure`-Cookie an — Loopback gilt als sicherer Kontext
—, über `http://192.168.1.10` **verwirft er es wortlos**. Die Anmeldung
antwortet dann mit 200 und jede weitere Anfrage ist anonym: es sieht aus wie
„das Passwort geht nicht", ist aber ein Cookie, das nie angekommen ist.

Mit `NODE_ENV=development` aus `.env.example` ist das schon richtig. Wer lokal
`NODE_ENV=production` ausprobiert, setzt zusätzlich
`SESSION_COOKIE_SECURE=false`. Welche Fassung gilt, sagt die API beim Start:

```
Session cookie: no Secure, named formsache_session (NODE_ENV=development) — …
```

⚠️ **`APP_BIND` ist nichts für dauerhaft.** Der Entwicklungsstapel trägt die
Seed-Konten mit `change-me-locally` als Passwort; auf `0.0.0.0` steht er dem
ganzen Netz offen. Für eine Installation, die wirklich ohne TLS betrieben wird,
steht der Weg mitsamt Preis in [`09-betrieb.md`](09-betrieb.md#betrieb-ohne-tls).

Zwei Dinge bleiben auch dann ungetan: **Basis-Adresse** und **SSO**. Links in
Mails und der `redirect_uri` der SSO-Anmeldung entstehen aus der gespeicherten
Basis-Adresse, nie aus der Aufruf-Adresse (siehe unten) — wer über die
IP-Adresse arbeitet, trägt genau diese dort ein.

## Die beiden Vorlagen für die .env

| Datei | Für | Angelegt mit |
|---|---|---|
| `.env.example` | Entwicklungsrechner und CI | `./scripts/dev-setup.sh` |
| `.env.prod.example` | eine Produktivinstallation | `./scripts/prod-setup.sh` |

Beide nennen jede Variable in einer Zeile Kommentar. Der Vertrag der Produktion
steht in [`09-betrieb.md`](09-betrieb.md); nur in `.env.example` stehen:

| Variable | Wozu |
|---|---|
| `SEED_ADMIN_*` | Der lokale Administrator. Ein zweiter Seed-Lauf setzt das Passwort **nicht** zurück |
| `SEED_MEMBER_*` | Mitglied in beiden Beispielorganisationen mit dem geringsten Recht — damit die Rechteprüfung jemanden **abzulehnen** hat |
| `SEED_TENANT_ADMIN_*` | Admin der zweiten Organisation, ausdrücklich **kein** Superadmin |
| `TEST_DATABASE_URL` | Basis-Verbindung für die Integrationstests (Rolle braucht `CREATEDB`) |
| `TEST_DATABASE_STRATEGY` | `auto` (Vorgabe) · `testcontainers` · `external` |
| `WEB_PORT` · `APP_PORT` · `POSTGRES_PORT` | Vite-Server · Container-Stack · lokale Datenbank |
| `APP_BIND` | Auf welcher Adresse der Container-Stack `APP_PORT` veröffentlicht; Vorgabe `127.0.0.1` |
| `E2E_BASE_URL` | Gegen welche Adresse `pnpm e2e` prüft; leer = der lokale Server |
| `CI` | Setzt das CI-System selbst |

`packages/shared/src/env-contract.test.ts` hält **jede Vorlage einzeln** gegen
das Zod-Schema: eine Seed-Zeile in der Produktionsvorlage wird ebenso rot wie
eine Testdatenbank darin.

`DATABASE_URL` schreibt Rolle, Passwort und Datenbankname noch einmal aus,
statt `${POSTGRES_USER}` zu interpolieren — der Loader der Anwendung löst
solche Referenzen nicht auf. Wer hier etwas ändert, ändert es oben mit.

## dev-setup.sh gehört hinter jedes git pull

`SECRET_BOX_KEY` ist Pflicht und steht in keiner Vorlage mit Wert — ein
Beispielschlüssel im Repository wäre echtes Schlüsselmaterial, das jeder hat.
`cp .env.example .env` ist deshalb kein vollständiger Setup-Schritt.
`scripts/dev-setup.sh`:

- legt `.env` aus `.env.example` an, falls sie fehlt;
- erzeugt jede fehlende oder leere Pflichtvariable (`openssl rand -base64 32`)
  und **gibt keinen erzeugten Wert aus**;
- lässt jeden vorhandenen Wert unangetastet;
- hängt neue Variablen aus der Vorlage **ans Ende** an, mit Wert und Kommentar;
- meldet Variablen, die die Vorlage nicht mehr kennt — und löscht sie nie.

Ohne diesen Abgleich fehlen nach einem `git pull` neue Variablen still: im
besten Fall bricht die API mit einem Zod-Fehler ab, im schlechteren läuft eine
optionale Variable auf ihrem Vorgabewert.

⚠️ **Auch `docker compose up -d db` braucht den Schlüssel** — Compose löst die
Variablen der ganzen Datei auf, bevor es ansieht, welcher Dienst gemeint war.
Geht der Schlüssel verloren, sind die gespeicherten Zugangswörter unlesbar;
eine Rotation wirft zusätzlich jedes gerade offene Ausfüll-Formular ab, also
rotieren, wenn niemand ausfüllt.

## Die Basis-Adresse steht in der Datenbank

Es gibt keine Umgebungsvariable dafür. Gültig ist `tenant.public_base_url`,
sonst `system_setting.public_base_url`, gepflegt unter *Systemverwaltung →
Mailserver* bzw. je Organisation unter *Organisations-Verwaltung → Mailversand*. Ist
keine gesetzt, entsteht **kein** Bearbeiten-Link — nicht etwa eine geratene
Adresse (`apps/api/src/common/public-url/public-url.service.ts`).

Für den Seed gibt es `SEED_PUBLIC_BASE_URL`:

```bash
SEED_PUBLIC_BASE_URL=http://127.0.0.1:5173 pnpm --filter @formsache/api seed
```

Ohne die Variable rührt der Seed die Spalte nicht an. `e2e/global-setup.ts`
setzt sie selbst.

| Betriebsart | Richtiger Wert |
|---|---|
| `docker compose up -d --build` | `http://127.0.0.1:8080` |
| `pnpm dev` | `http://127.0.0.1:5173` |
| `pnpm e2e` | `http://127.0.0.1:5173` — setzt der Lauf selbst |

Nichts prüft, ob die gespeicherte Adresse zur laufenden Betriebsart passt: ein
falscher Wert erzeugt Links auf einen Port, auf dem gerade nichts läuft.

## Postgres ohne Docker

Ohne Docker-Daemon tritt eine lokale Installation an die Stelle des
Compose-Dienstes. Ein frisches Cluster ist leer — Rolle und Datenbank aus
`DATABASE_URL` müssen angelegt werden:

```bash
pg_ctlcluster 16 main start
su postgres -c "psql -c \"create role formsache with login createdb password 'change-me-locally';\""
su postgres -c 'psql -c "create database formsache owner formsache;"'
```

`CREATEDB` ist nicht optional: die Integrationstests legen je Aufruf eine
eigene Wegwerf-Datenbank an.

## Testdatenbanken

`acquireTestDatabase()` (`apps/api/test/database/test-database.ts`) liefert je
Aufruf eine frische, exklusive Datenbank ([ADR-0008](../architecture/0008-test-database-provider.md)):

| Lage | Weg |
|---|---|
| Docker-Daemon antwortet | Testcontainers, `postgres:17-alpine` |
| sonst | eine Datenbank im Server aus `TEST_DATABASE_URL`, ersatzweise `DATABASE_URL` — danach wieder gelöscht |
| weder noch | die Suite ist **rot**, nicht übersprungen; die Meldung nennt beide Auswege |

Welcher Weg gefahren wurde, steht als `[test-database]`-Zeile im Testprotokoll.
Die CI fährt den externen Weg (`TEST_DATABASE_STRATEGY=external`) und misst den
Testcontainers-Weg in einem eigenen Schritt.

Ein hart abgeschossener Lauf hinterlässt seine Wegwerf-Datenbank; aufgeräumt
wird beim nächsten Anlegen, bei Resten älter als zwei Stunden. Sofort:
`psql "$DATABASE_URL" -c 'DROP DATABASE "formsache_test_…"'`.

## Prüfbefehle

```bash
pnpm -r build       # Build aller Workspaces
pnpm -r test        # Vitest und API-Integrationstests (braucht Postgres)
pnpm typecheck      # erfasst auch Test-, e2e- und Tooling-Dateien
pnpm lint           # ESLint an der Wurzel — nicht `pnpm -r lint`
pnpm format         # Prettier (Prüfmodus: pnpm format:check)
pnpm e2e            # Playwright, bei UI- oder Flow-Änderungen
```

Drei Werkzeugentscheidungen, die man beim Ändern kennen muss:

- **`packages/shared` wird im Dev- und Testpfad aus der Quelle konsumiert**
  (`development`-Condition in `exports`, [ADR-0007](../architecture/0007-shared-package-consumption.md)).
  Ein weiteres internes Paket braucht dieselbe Condition in den Konsumenten.
- **NestJS braucht `emitDecoratorMetadata`.** esbuild kann das nicht; `tsx` und
  esbuild-Loader starten die Anwendung scheinbar und liefern dann bei jeder
  DI-Route einen 500er. Dev-Pfad und Vitest in `apps/api` laufen über SWC, der
  Produktionsbuild über `tsc`.
- **`@playwright/test` ist exakt gepinnt** (ohne Caret): die Browser liegen
  vorinstalliert unter `PLAYWRIGHT_BROWSERS_PATH`. Ein Versionssprung braucht
  `pnpm exec playwright install chromium` im selben Zug.

## pnpm e2e

Der Lauf **gehört die Datenbank, auf die `DATABASE_URL` zeigt**: sein
`globalSetup` fährt `prisma migrate deploy`, danach `reset-data` (leert jede
Tabelle außer `_prisma_migrations`) und den Seed. Wer dort etwas aufbewahrt,
zeigt vorher woandershin. Unter `.playwright/auth/` legt der Lauf eine lebende
Sitzung ab.

Der Lauf macht vier Anmeldungen gegen ein Limit von zehn pro Minute und
Adresse: zwei Läufe kurz hintereinander gehen, drei nicht — ein `429` ist dann
ein Budgetproblem des Laufs.

⚠️ **Was nach einem Lauf in der Datenbank steht, hat dieser Lauf angelegt — es
ist kein Rückstand.** Weil `globalSetup` vor *jedem* Lauf leert und neu sät,
kann dort nichts aus einer früheren Sitzung liegen. Gemessen am 2026-09-13 nach
einem abgebrochenen `pnpm e2e`: 107 Formulare, deren `created_at` allesamt in
denselben zweieinhalb Minuten liegen. Eine hohe Zahl ist deshalb **kein**
Befund, und die Entwicklungsdatenbank von Hand zurückzusetzen ist **keine**
Abhilfe — es tut genau das, was der nächste Lauf ohnehin als Erstes tut. Klein
wird sie, wenn der Lauf **durchläuft**: `durchlauf-erstinbetriebnahme` leert und
sät am Ende ein zweites Mal, und genau dieser Schritt fällt aus, sobald ein
früheres Projekt rot war. Ein voller Stand ist also die *Folge* eines
fehlgeschlagenen Laufs und nicht seine Ursache.

**`test-results/` wird zu Beginn jedes Laufs geleert.** `trace.zip` und
Screenshot eines Fehlschlags überstehen den nächsten Lauf nicht — wer sie zur
Diagnose braucht, sichert das Verzeichnis weg, **bevor** er die Suite erneut
startet.

**API und Playwright müssen auf demselben Host sitzen.** Das fünfte Projekt
(`durchlauf-organisationen`) fährt einen vollständigen SSO-Anmeldevorgang; der
Test-Provider läuft auf einem Loopback-Port und wird vom Browser **und** von
der API angesprochen. Gegen den Container-Stack scheitert das, weil
`127.0.0.1` dort der Container ist — sichtbar als *„Die Anmeldung über SSO ist
fehlgeschlagen"*. Der Weg gegen den Stack ist der Lauf ohne dieses Projekt:

```bash
E2E_BASE_URL=http://127.0.0.1:8080 npx playwright test \
  --project=setup --project=smoke \
  --project=desktop-1280x800 --project=mobile-360x740
```

Eine neue Spec-Datei muss in die `testMatch`-Liste ihres Projekts in
`playwright.config.ts` — sonst führt sie null Tests aus und der Lauf bleibt
grün. Prüfen mit `npx playwright test --list`.

## Die Pipeline

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), ausgelöst von
jedem Push auf jedem Branch. Sieben Jobs:

| Job | Was er fährt | Läuft |
|---|---|---|
| `quality` | `lint`, `format:check`, `typecheck`, `build`, `check-ai-docs.sh`, die Skript-Szenarien aus `scripts/tests/` und `pnpm audit` als Bericht | immer, auch bei Doku-Pushs |
| `test` | Unit + Integration, PostgreSQL-17-Client, `backup.sh`-Szenarien, Testcontainers-Weg | nicht bei Doku-Pushs |
| `e2e` | Playwright | nicht bei Doku-Pushs |
| `stack` | Images bauen, Nicht-Root prüfen, Stack starten, Version gegen GitVersion halten, Anmeldung durch den Frontdoor | nicht bei Doku-Pushs |
| `restore` | Sicherung → `down -v` → Wiederherstellung → prüfen, was zurückkam | nicht bei Doku-Pushs |
| `publish` | GHCR, nur auf `main`, nach den fünf darüber | nur `main` |
| `load` | Lasttest als Bericht (`continue-on-error`) | auf Zuruf und wöchentlich |

**Container-Änderungen sind erst belegt, wenn der `stack`-Job sie gefahren
hat** — jede Änderung an `docker-compose*.yml`, einem `Dockerfile` oder der
nginx-Konfiguration wird gepusht und im Job nachgesehen.

`test`, `e2e` und `stack` starten immer; ihr erster Schritt ruft
[`scripts/ci-docs-only.sh`](../../scripts/ci-docs-only.sh) auf, und bei einer
reinen Doku-Änderung überspringen die folgenden Schritte sich selbst. Bewusst
kein `paths-ignore`: ein übersprungener Pflicht-Check verschwindet als
`skipped` und blockiert eine Branch-Protection. Verglichen wird gegen die
**Merge-Base zum Default-Branch**, nicht gegen den vorherigen Push — sonst
trüge der Kopf eines Branches ein grünes Häkchen für einen Code-Stand, den nie
jemand gefahren hat.

Beim Ändern der Pipeline:

- Ein Push mit mehreren Commits erzeugt **einen** Lauf, auf dem Kopf des Pushes.
- **`gitversion/execute` wird nicht benutzt** — die Action schreibt ihr
  Protokoll in denselben Strom, den sie als JSON liest. Die Pipeline ruft die
  Binary direkt auf.
- Die `feature`-Regex in `GitVersion.yml` braucht ihre `BranchName`-Gruppe,
  sonst heißt die Version wörtlich `0.1.0-{BranchName}.1`.
- `Timed out waiting … from config.webServer` hat zwei Ursachen: ein kalter
  Build (der CI-Job baut deshalb vorher) oder die Adressfamilie — Vites
  Vorgabe-Host `localhost` bindet an `::1`, Playwright fragt `127.0.0.1`.
  `apps/web/vite.config.ts` schreibt den Host deshalb aus.
