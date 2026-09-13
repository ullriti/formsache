# AGENTS.md

Anweisungen für KI-Agenten in diesem Repository. `CLAUDE.md` importiert diese
Datei — **immer hier bearbeiten**.

Die Regeln sind dieselben wie für Menschen; ausführlicher stehen sie in
[`CONTRIBUTING.md`](CONTRIBUTING.md). Was hier steht, ist die knappe Fassung
plus das, was nur für Agenten gilt.

## Sprachen

- **Chat** (Agent ↔ Nutzer): Deutsch, Du-Form
- **Dokumentation** (docs/, README, CHANGELOG): Deutsch
- **Code** (Bezeichner, Kommentare, Commit-Nachrichten): Englisch
- **Oberflächentexte der Anwendung**: Deutsch
- **URL-Pfade**: Englisch — sie sind Bezeichner, keine Oberfläche
  ([ADR-0030](docs/architecture/0030-englische-url-pfade.md)). `/admin/trash`
  trägt die Überschrift „Papierkorb"; die Adresse ist Code, der Text ist
  Oberfläche.

  ⚠️ Diese eine Zeile hat als Prosa **nicht** gereicht: über Monate wuchsen
  `/verwaltung/ueberwachung` und `/einladung/<token>` heran, jedes einzelne
  unauffällig. Deshalb steht die vollständige Liste der Adress-Segmente seit
  Review-Runde 4 in `apps/web/src/router/address-segments.test.ts` und ein
  neues Wort macht den Test rot.

## Das Projekt

**Formsache** — eine mandantenfähige Formular- und Umfrageplattform zum
Selbsthosten. Formular-Builder mit Drag & Drop, öffentliches Ausfüllen ohne
Login, Auswertung mit Export, Benachrichtigungen, Gruppenrechte und
Organisationsverwaltung mit eigenem Erscheinungsbild.

TypeScript als pnpm-Monorepo (`apps/web`, `apps/api`, `packages/shared`),
React 19 mit Vite, NestJS auf Node 22, PostgreSQL mit Prisma (Formularschema
und Antworten als JSONB), Zod als geteilte Validierung, Vitest und Playwright,
Docker Compose.

Architektur und Entscheidungen stehen in [`docs/kb/`](docs/kb/README.md) und
den [ADRs](docs/architecture/). **Vor größerer Arbeit dort nachlesen.**

## Aufsetzen

```bash
corepack enable
./scripts/dev-setup.sh          # installiert, .env anlegen + Schlüssel erzeugen
docker compose up -d db
pnpm --filter @formsache/api exec prisma migrate deploy
pnpm --filter @formsache/api seed
```

`dev-setup.sh` gehört hinter jedes `git pull` — es gleicht die `.env` mit
`.env.example` ab und installiert Abhängigkeiten. Ohne den Abgleich fehlen neue
Variablen still.

## Prüfen

Vor Abschluss einer Aufgabe **müssen** die zutreffenden Befehle grün sein:

```bash
pnpm -r build       # Build aller Workspaces
pnpm -r test        # Vitest und API-Integrationstests
pnpm typecheck      # erfasst auch Test-, e2e- und Tooling-Dateien
pnpm lint           # ESLint, type-aware, an der Wurzel
pnpm format         # Prettier (Prüfmodus: pnpm format:check)
pnpm e2e            # Playwright — bei UI- oder Flow-Änderungen
```

> **`pnpm lint`, nicht `pnpm -r lint`** — `pnpm -r` überspringt das Wurzelpaket
> und ließe `e2e/`, `tools/` und die Konfiguration ungeprüft.
>
> **`pnpm typecheck` ist nicht Teil von `build`.**
>
> Ein Agent, der einen Befehl nicht ausführen kann, **sagt das ausdrücklich**,
> statt ihn stillschweigend zu überspringen.

## Arbeitsregeln

- **Tests grün vor und nach jeder Änderung.** Neues Verhalten braucht Tests,
  ein Bugfix einen Regressionstest.
- **Jede Rechte- und Isolationsregel braucht einen Integrationstest, der den
  unerlaubten Zugriff scheitern sieht.** Ein Test, der nur den erlaubten Fall
  prüft, belegt nichts.
- **Nutzersichtbares Verhalten ändert man absichtlich**, nie nebenbei — und
  benennt es.
- **Mehrteilige Arbeit aufteilen** und an die Spezialisten-Agenten in
  `.claude/agents/` delegieren — **oder** direkt erledigen, mit Begründung,
  wenn die Änderung so eng verzahnt ist (etwa eine geteilte Schnittstelle),
  dass ein einzelner Kontext robuster ist. Die Entscheidung fällt **bewusst**
  am Anfang und wird benannt.
- **Vor dem Abschluss** `/review` (oder den `code-reviewer`) als blockierendes
  Qualitätstor laufen lassen und die Befunde beheben oder begründet
  zurückweisen.
- **Wissen gehört ins Repository, nicht ins lokale Gedächtnis.** Erkenntnisse
  und Entscheidungen in `docs/kb/`, ADRs und `CHANGELOG.md` — **nie** in
  `~/.claude/` oder `#`-Memory. Lokales Gedächtnis wird nicht geteilt und ist
  nach der Sitzung weg.

## Konventionen

Vollständig in [`CONTRIBUTING.md`](CONTRIBUTING.md). Das Wichtigste:

- **TypeScript strict.** Kein `any`; Fremddaten kommen als `unknown` herein und
  werden durch ein Zod-Schema geparst.
- **Zod-Schemas in `packages/shared` sind die Wahrheit.** Typen per `z.infer`
  ableiten, niemals Schema und Interface parallel pflegen. Der Server
  validiert immer selbst.
- **Frontend:** Funktionskomponenten und Hooks, Design-Tokens statt
  hartcodierter Farben, TanStack Query für Server-State, Zustand für den
  Builder — nicht vermischen.
- **Backend:** ein Modul je Domäne, Autorisierung in Guards, jeder fachliche
  Zugriff tenant-scoped (`tenant_id` in der Abfrage, nicht erst im Filter
  danach). Migrationen werden nie nachträglich editiert.
- **Conventional Commits** — GitVersion leitet die Version daraus ab.
- **Kommentare erklären das Warum.** Bestehende Muster übernehmen, keine neuen
  erfinden.

## Grenzen

- **Niemals Geheimnisse committen.** Alles Umgebungsabhängige kommt aus
  Umgebungsvariablen.
- **Mandantentrennung ist eine Sicherheitsgrenze, keine Anzeigefrage.**
  Durchgesetzt wird serverseitig und durch Tests belegt.
- **Öffentliche Ausfüll-Endpunkte sind ungeschützt erreichbar** —
  Rate-Limiting, Payload-Grenzen, Upload-Positivliste und serverseitige
  Validierung gehören zu jeder Änderung daran.
- **Personenbezogene Daten sparsam** (DSGVO): keine Teilnehmerkonten,
  Löschfristen einhalten, endgültiges Löschen ist physisches Löschen.
- **Keine zerstörenden Aktionen** (Daten löschen, `main` force-pushen) ohne
  ausdrückliche Zustimmung.
- **Bei unklarem Umfang: fragen, nicht raten.**

## Verzeichnisse

| Pfad | Inhalt |
|------|--------|
| `apps/web/` | Frontend: React 19 + Vite |
| `apps/api/` | Backend: NestJS, Guards, Prisma-Schema und Migration |
| `packages/shared/` | Geteilte Zod-Schemas und Kernlogik |
| `e2e/` | Playwright-Durchläufe |
| `scripts/` | Setup, Sicherung, Wiederherstellung, Rauchtest |
| `docs/kb/` | Wissensbasis — Architektur, Datenmodell, Betrieb, Datenschutz |
| `docs/architecture/` | Architekturentscheidungen (ADRs) |
| `.claude/agents/` | Spezialisten-Agenten |
| `.claude/commands/` | Slash-Kommandos |
