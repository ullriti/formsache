# Formsache

Eine mandantenfähige Formular- und Umfrageplattform zum Selbsthosten: Formulare
mit Drag & Drop bauen, öffentlich und ohne Login ausfüllen lassen, Antworten
auswerten und exportieren — jede Organisation mit eigenem Erscheinungsbild.

Gebaut für Verbände und Vereine, die Anmeldungen, Meldungen und Rückläufe heute
per Zettel und Mail abwickeln: eine Dachorganisation, darunter die
Mitgliedsorganisationen, jede mit eigenen Formularen, eigenen Rechten und
eigenem Logo — aber einer gemeinsamen Installation.

## Was drin ist

- **Formular-Builder** mit sechzehn Fragetypen, mehrseitigen Formularen,
  bedingter Anzeige von Fragen und Seiten, Vorschau und Testmodus.
  Drag & Drop mit Maus **und** Touch.
- **Öffentliches Ausfüllen ohne Konto** — mit Zwischenspeichern und
  Wiederaufnahme, Bearbeiten nach dem Absenden, Passwortschutz, Fristen,
  Teilnehmerlimits und Warteliste.
- **Auswerten und exportieren** als CSV, Excel und HTML, über
  Formularversionen hinweg.
- **Benachrichtigungen** mit Vorlagen und Platzhaltern, Warteschlange mit
  Wiederholung, Versandprotokoll und eigener Absenderidentität je Organisation.
- **Rechte** über Gruppen und je Formular; Anmeldung lokal oder über OIDC.
- **Papierkorb** mit 30-Tage-Frist, danach physisches Löschen.
- **KI-gestützte Formularerstellung** — optional, mit eigenem API-Schlüssel
  (Anthropic oder Mistral). Ohne Schlüssel bleibt die Funktion aus.
- **Betrieb**: Container-Stack, Sicherung und Wiederherstellung als Skript,
  Rauchtest, Betriebsüberwachung, Betriebs- und Datenschutzhandbuch.

## Reifegrad

Die Anwendung **ist produktiv im Einsatz**. Issues sind willkommen;
eine Support-Zusage gibt es nicht. Wer sie einsetzt, betreibt sie selbst — die
Betriebsdokumentation ist entsprechend ausführlich.

Eine bekannte Einschränkung: `pnpm audit` meldet eine mittelschwere
Schwachstelle in `uuid`, die über `exceljs` hereinkommt. Sie betrifft den
Excel-Export; ein Wechsel des Pakets steht aus.

## Schnellstart

Zwei Wege, und sie schließen einander nicht aus: der **Container-Stack** ist
der kürzeste Weg zu einer laufenden Anwendung, die **Entwicklungsumgebung** der
Weg zum Arbeiten am Code.

### Container-Stack

Vorausgesetzt sind Docker und Docker Compose — sonst nichts.

```bash
git clone https://github.com/ullriti/formsache.git
cd formsache
./scripts/dev-setup.sh                      # .env + Schlüssel, nie committen
docker compose up -d --build                # db → Migration → api → web
docker compose run --rm migrate db seed     # lokaler Administrator
```

`./scripts/dev-setup.sh` statt `cp .env.example .env`: die Beispieldatei führt
`SECRET_BOX_KEY` bewusst **ohne** Wert, denn ein Beispielschlüssel im
Repository wäre echtes Schlüsselmaterial — und ohne Wert startet der Stack
nicht. Das Skript legt die `.env` an, erzeugt die fehlenden Schlüssel und lässt
vorhandene Werte in Ruhe. Es gleicht außerdem `.env` mit `.env.example` ab, und
darum gehört es hinter jedes `git pull`, das die Beispieldatei anfasst; es darf
beliebig oft laufen.

Danach liegt die Anwendung auf <http://127.0.0.1:8080>, angemeldet wird sich
mit `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` aus der `.env`.

> Der Stack ist für die lokale Nutzung gedacht: alle Ports hängen an
> `127.0.0.1`, `NODE_ENV` steht auf `development`, das Passwort ist ein
> Platzhalter. Was für einen erreichbaren Server zu ändern ist, steht in
> [`docs/kb/04-build-run.md`](docs/kb/04-build-run.md).

### Entwicklungsumgebung

Vorausgesetzt sind Node ≥ 22.12 und Docker für die Datenbank.

```bash
corepack enable                       # stellt die gepinnte pnpm-Version bereit
./scripts/dev-setup.sh                # installiert, .env + Schlüssel
docker compose up -d db               # nur die Datenbank
pnpm --filter @formsache/api exec prisma migrate deploy
pnpm --filter @formsache/api seed
pnpm --filter @formsache/api dev      # API auf :3000
pnpm --filter @formsache/web dev      # Web auf :5173, /api wird durchgereicht
```

## Prüfbefehle

| Befehl | Prüft |
|--------|-------|
| `pnpm -r build` | Build aller Workspaces |
| `pnpm -r test` | Unit- und Integrationstests (braucht Postgres) |
| `pnpm typecheck` | Typen, inklusive Test-, e2e- und Tooling-Dateien |
| `pnpm lint` | ESLint, type-aware, an der Wurzel |
| `pnpm format:check` | Prettier (`pnpm format` schreibt) |
| `pnpm e2e` | Playwright, Desktop- und Mobil-Viewport |

Dieselben Befehle laufen in der [CI](.github/workflows/ci.yml). Die
Anwendungsversion leitet GitVersion aus der Commit-Historie ab; sie steht im
Image-Tag und in der Antwort von `GET /api/health`.

## Aufbau

| Pfad | Inhalt |
|------|--------|
| `apps/web/` | Frontend: React 19 + Vite, Design-Tokens |
| `apps/api/` | Backend: NestJS, Guards, Prisma-Schema und Migration |
| `packages/shared/` | Geteilte Zod-Schemas und Kernlogik für Client **und** Server |
| `e2e/` | Playwright-Durchläufe, Desktop- und Mobil-Viewport |
| `docker/` | Beiwerk des Stacks (TLS-Frontdoor) |
| `scripts/` | Setup, Sicherung, Wiederherstellung, Rauchtest |
| `docs/kb/` | Wissensbasis: Architektur, Datenmodell, Betrieb, Datenschutz |
| `docs/architecture/` | Architekturentscheidungen (ADRs) — *warum* es so ist |

Wer mitarbeiten will, findet den Einstieg in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Technik

TypeScript durchgehend, als pnpm-Monorepo. React 19 mit Vite im Frontend,
NestJS auf Node 22 im Backend, PostgreSQL mit Prisma — das Formularschema und
die Antworten liegen als JSONB. Zod-Schemas in `packages/shared` sind die
gemeinsame Wahrheit für Client und Server; der Server validiert immer selbst.
Getestet wird mit Vitest und Playwright.

Die Anwendung ist **hosting-agnostisch**: alles Umgebungsabhängige (Datenbank,
SMTP, OIDC, KI-Schlüssel, Ablage) kommt aus Umgebungsvariablen. Keine Annahmen
über Server, Mailserver oder Identitätsanbieter stecken im Code.

## Betrieb

`docker-compose.prod.yml` legt die Produktionsgestalt über den Stack
(TLS-Frontdoor, veröffentlichte Images). Die `.env` des Servers entsteht aus
`.env.prod.example` mit `./scripts/prod-setup.sh` — einer eigenen Vorlage, damit
kein Seed-Kennwort auf einem Server landet und keine Zertifikatszeile auf einem
Entwicklungsrechner. Gesichert wird mit
`scripts/backup.sh` — Datenbank **und** hochgeladene Dateien in einem
verschlüsselten Archiv —, zurückgespielt mit `scripts/restore.sh`, geprüft mit
`scripts/smoke.sh` gegen eine laufende Installation. Der erste Administrator
einer echten Installation entsteht **nicht** über den Seed; der Weg dafür und
alles Weitere steht im Betriebshandbuch
[`docs/kb/09-betrieb.md`](docs/kb/09-betrieb.md), das Löschkonzept in
[`docs/kb/10-datenschutz.md`](docs/kb/10-datenschutz.md).

## Sicherheit und Datenschutz

- **Mandantentrennung ist eine Sicherheitsgrenze, keine Anzeigefrage.** Sie
  wird serverseitig durchgesetzt und durch Integrationstests belegt, die den
  verbotenen Zugriff scheitern *sehen* — ein Test, der nur den erlaubten Fall
  prüft, belegt nichts.
- **Öffentliche Ausfüll-Endpunkte sind ungeschützt erreichbar.** Rate-Limiting,
  Payload-Grenzen, Upload-Positivliste und serverseitige Schema-Validierung
  gehören zu jeder Änderung daran.
- **Kein Geheimnis gehört ins Repository.** `.env.example` und
  `.env.prod.example` dokumentieren jede Variable und enthalten ausschließlich
  Platzhalter; die Pflichtschlüssel stehen dort leer und werden von den
  Setup-Skripten auf der Maschine erzeugt.
- **Personenbezogene Daten sparsam**: keine Teilnehmerkonten, Papierkorb 30
  Tage, Versandprotokoll 90 Tage, endgültiges Löschen ist physisches Löschen.

Eine Schwachstelle melden: [`SECURITY.md`](SECURITY.md).

## Lizenz

[MIT](LICENSE)
