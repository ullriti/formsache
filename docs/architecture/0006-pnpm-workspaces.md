# 6. Monorepo-Verwaltung mit pnpm-Workspaces

- **Status:** accepted
- **Date:** 2026-07-26

## Context

Die Spezifikation legt ein Monorepo mit drei Workspaces fest (`apps/web`, `apps/api`,
`packages/shared`), aber nicht das Werkzeug dafür. Zur Wahl standen die in Node
22 eingebauten **npm-Workspaces** und **pnpm**. Beide beherrschen die Grundlagen
(ein Lockfile, Verlinkung der internen Pakete, Skripte je Workspace), die
Unterschiede liegen in Strenge, Installationskosten und Docker-Tauglichkeit.

Für dieses Projekt sind zwei Randbedingungen ausschlaggebend: `packages/shared`
wird von beiden Apps benutzt (die Zod-Schemas sind Wire-Contract), und es
entstehen zwei getrennte Docker-Images aus demselben Repo.

## Decision

Das Monorepo wird mit **pnpm-Workspaces** verwaltet. pnpm kommt über **Corepack**
und wird im `packageManager`-Feld der Wurzel-`package.json` auf eine Version
gepinnt. Geteilte Abhängigkeitsversionen (React, Zod, TypeScript …) werden über
`catalog:` zentral gehalten. In CI und Docker gilt `--frozen-lockfile`.

Ausschlaggebend:

- **Strikte Auflösung.** npm hoisted alle Abhängigkeiten in ein flaches
  `node_modules`; ein Workspace kann dadurch Pakete importieren, die er nie
  deklariert hat („Phantom-Dependencies") – lokal grün, im Docker-Build rot.
  pnpm macht nur Deklariertes importierbar.
- **Store statt Kopien.** Content-addressed Store mit Hardlinks: spürbar
  schnellere Installationen in CI und deutlich weniger Plattenbedarf über
  Branches/Worktrees hinweg.
- **Graph-bewusste Filter.** `pnpm --filter web...` baut ein Paket samt seiner
  internen Abhängigkeiten in topologischer Reihenfolge; `npm -w` kennt nur
  „führe in diesem Workspace aus".
- **`pnpm deploy`** erzeugt für jedes App-Image einen gepruneten Ordner – ohne
  Zusatzwerkzeug wie Turborepo-Prune.
- **Lifecycle-Skripte** laufen nur für ausdrücklich erlaubte Pakete (kleiner
  Supply-Chain-Gewinn).

## Consequences

- Zusätzliches Werkzeug in der Toolchain – gering gehalten durch Corepack (kein
  globales Installieren, Version im Repo gepinnt).
- Das nicht-flache `node_modules` (Symlinks) kann ältere Werkzeuge irritieren;
  Abhilfe im Einzelfall über `public-hoist-pattern`, bewusst und begründet.
- Nur **ein** Paketmanager im Repo: ein `package-lock.json` neben
  `pnpm-lock.yaml` ist ein Fehler und wird in CI abgelehnt.
- Alle Kommandos in `AGENTS.md`, `scripts/bootstrap.sh`, CI und Dockerfiles
  nutzen `pnpm`.
