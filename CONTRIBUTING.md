# Mitarbeit

Beiträge sind willkommen. Dieses Dokument sagt, wie das Projekt gebaut,
geprüft und beigesteuert wird. Die Regeln für KI-Agenten stehen in
[`AGENTS.md`](AGENTS.md) und sind dieselben — nur knapper aufgeschrieben.

## Aufsetzen

```bash
corepack enable                       # stellt die gepinnte pnpm-Version bereit
./scripts/dev-setup.sh                # installiert, legt .env an, erzeugt Schlüssel
docker compose up -d db               # Datenbank
pnpm --filter @formsache/api exec prisma migrate deploy
pnpm --filter @formsache/api seed
```

`dev-setup.sh` ist **kein einmaliger Schritt**: es gleicht die `.env` mit
`.env.example` ab und installiert die Abhängigkeiten. Nach einem `git pull`
noch einmal laufen lassen, sonst fehlen neue Variablen still.

## Prüfen

Vor jedem Push müssen diese grün sein:

```bash
pnpm -r build       # Build aller Workspaces
pnpm -r test        # Vitest und die API-Integrationstests
pnpm typecheck      # tsc --noEmit, erfasst auch Test-, e2e- und Tooling-Dateien
pnpm lint           # ESLint, type-aware, an der Wurzel
pnpm format         # Prettier (Prüfmodus: pnpm format:check)
pnpm e2e            # Playwright — bei UI- oder Flow-Änderungen
```

Zwei Fallen, die Zeit kosten:

- **`pnpm lint`, nicht `pnpm -r lint`.** `pnpm -r` überspringt das Wurzelpaket
  und ließe `e2e/`, `tools/` und die Konfigurationsdateien ungeprüft.
- **`pnpm typecheck` ist nicht Teil von `build`.** Der Build erzeugt nur
  Artefakte; die Typprüfung deckt zusätzlich Tests und Tooling ab.

Wer einen Befehl nicht ausführen kann, sagt das im Pull Request ausdrücklich,
statt ihn stillschweigend auszulassen.

## Was ein Beitrag mitbringt

- **Tests.** Neues Verhalten braucht einen Test, ein Bugfix einen
  Regressionstest. Der Schwerpunkt liegt unten in der Pyramide: geteilte
  Kernlogik in `packages/shared` mit Vitest.
- **Jede Rechte- und Isolationsregel braucht einen Integrationstest, der den
  unerlaubten Zugriff scheitern sieht.** Ein Test, der nur den erlaubten Fall
  prüft, belegt nichts.
- **Nutzersichtbare Änderungen werden benannt** — im Pull Request und, wenn sie
  der Rede wert sind, in [`CHANGELOG.md`](CHANGELOG.md) unter `[Unreleased]`.

## Code-Stil

Prettier und ESLint sind maßgeblich; manuelle Abweichungen überschreibt der
Formatter. Darüber hinaus:

- **TypeScript strict.** Kein `any`. Fremddaten kommen als `unknown` herein und
  werden durch ein Zod-Schema geparst. Keine Non-Null-Assertion ohne einen
  Kommentar, der begründet, warum der Wert nicht null sein kann.
- **Zod-Schemas in `packages/shared` sind die Wahrheit** für Formularschema,
  bedingte Logik und Antwortvalidierung. Typen per `z.infer` ableiten, niemals
  Schema und Interface parallel pflegen. Der Server validiert immer selbst —
  die Clientvalidierung ist reine Bequemlichkeit.
- **Frontend:** Funktionskomponenten und Hooks. Farben, Abstände und Typografie
  ausschließlich über die Design-Tokens (CSS-Variablen), keine hartcodierten
  Farbwerte. Server-State über TanStack Query, Builder-State über Zustand —
  nicht vermischen.
- **Backend:** ein NestJS-Modul je Domäne. Autorisierung gehört in Guards,
  nicht verstreut in Controller und Services. Jeder fachliche Zugriff ist an
  eine Organisation gebunden — `tenant_id` in der Abfrage, nicht erst im Filter
  danach. Migrationen werden nie nachträglich editiert.
- **Dateinamen:** React-Komponenten `PascalCase.tsx`, alles andere kebab-case;
  im Backend die NestJS-Suffixe (`*.controller.ts`, `*.service.ts`,
  `*.guard.ts`, `*.module.ts`).
- **Kommentare erklären das Warum, nicht das Was.**
- Sprache: Code, Bezeichner, Kommentare und Commit-Nachrichten **englisch**,
  Dokumentation und Oberflächentexte **deutsch**.
- **Die Anwendung duzt.** Jeder Text, den ein Mensch auf dem Bildschirm liest —
  Beschriftungen, Hinweise, Bestätigungen, Fehlermeldungen, Mailtexte an
  angemeldete Personen — steht in der Du-Form. Das ist keine Geschmacksfrage je
  Ansicht: eine Seite, die siezt, während die daneben duzt, liest sich wie zwei
  Anwendungen. Wer eine neue Ansicht baut, übernimmt die Form der bestehenden,
  statt sie neu zu entscheiden.

## Commits und Branches

- **Conventional Commits**: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
  `chore:`, `build:`, `ci:` — optional mit Scope: `feat(web):`, `fix(api):`.
  Das ist keine Kosmetik: GitVersion leitet die Anwendungsversion aus dieser
  Historie ab. `feat:` hebt Minor, `fix:` Patch, `BREAKING CHANGE:` im Footer
  Major.
- Ein Commit ist eine logische Änderung und für sich baubar.
- Imperativ, Präsens: „add …", nicht „added …".
- Branches: `<feat|fix>/<kurze-beschreibung>`.
- **Der Pull-Request-Titel folgt derselben Konvention** — beim Squash-Merge
  *wird* er die Commit-Nachricht und damit die Grundlage der Versionsableitung.
  Ein Titel ohne Typ verschiebt die Version falsch.

## Neue Abhängigkeiten

Begründen. Bundle-Größe und Angriffsfläche zählen mit; die Standardbibliothek
und vorhandene Hilfsmittel gehen vor. Versionen, die mehrere Workspaces teilen,
stehen im pnpm-`catalog:` und werden nicht je Workspace einzeln gepinnt.

## Sicherheit

Schwachstellen **nicht** über ein öffentliches Issue melden — der Weg steht in
[`SECURITY.md`](SECURITY.md).

Bei Änderungen an sicherheitsrelevanten Stellen (Mandantentrennung,
Rechteprüfung, öffentliche Endpunkte, Uploads, Sitzungen, Geheimnisse) im Pull
Request ausdrücklich darauf hinweisen.

## Wenn etwas unklar ist

Bei Fragen zu Umfang oder Architektur: **fragen, nicht raten.** Ein Issue mit
der Frage ist billiger als ein Pull Request, der am Ziel vorbeigeht.
