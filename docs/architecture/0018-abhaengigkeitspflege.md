# 18. Abhängigkeitspflege — Dependabot hebt, der Bericht misst, die Erreichbarkeit entscheidet

- **Status:** accepted
- **Date:** 2026-08-12

## Context

`scripts/audit-report.sh` läuft in der CI und meldet, was neu verwundbar ist.
Was fehlte, war die andere Hälfte: **ein Weg, eine Meldung wieder loszuwerden.**

Die Folge war messbar. Die Grundlinie führte zum Zeitpunkt dieser Entscheidung
**acht Meldungen** (sechs hoch, zwei mittel), und keine davon war jemals bewertet
worden — sie standen als „bekannt" da, was etwas anderes ist als „tragbar".
Nachgesehen waren sie in **sieben von acht Fällen längst behoben**: die
Fassungen lagen im Bereich, den die Abhängigkeiten ohnehin erlauben. Es fehlte
niemand, der die Sperrdatei anfasst.

Das ist das eigentliche Risiko dieser Anwendung: nicht die exotische Lücke,
sondern die geschlossene Lücke, die niemand einspielt. Sie verarbeitet
personenbezogene Daten und wird öffentlich erreichbar sein.

Drei Eigenheiten dieses Repositorys prägen die Lösung:

1. **Der PR-Titel setzt die Version.** Beim Squash-Merge wird er zur
   Commit-Message, und GitVersion leitet daraus die App-Version ab (ADR-0009).
   Ein Bot, der `chore:` über eine ausgelieferte Bibliothek schreibt,
   verschiebt die Version falsch — und einer, der `feat:` schreibt, ebenso.
2. **Fast alle Meldungen sind Entwicklungswerkzeug.** Von den acht hingen fünf
   an der Prisma-CLI, an ESLint und an Vite — nichts davon führt ein
   Produktionsserver je aus. Ein *blockierendes* Gate wäre hier ab Tag eins rot
   und binnen dreier Wochen abgeschaltet.
3. **Nicht jede Meldung ist behebbar.** `exceljs` pinnt `uuid: ^8.3.0`, und die
   Behebung liegt in `uuid@11`. Der Sprung ginge nur als erzwungene
   Überschreibung über eine Major-Grenze hinweg — in einer Bibliothek, die zur
   Laufzeit Tabellen schreibt.

## Decision

### 1. Dependabot hebt, wöchentlich und gebündelt

`.github/dependabot.yml` deckt drei Ökosysteme ab: `npm` (die pnpm-Sperrdatei),
`github-actions` und `docker` für die beiden Laufzeit-Images.

**Wöchentlich und gruppiert**, nicht täglich und einzeln. Ein Repository, das
acht Einzel-PRs am Tag bekommt, gewöhnt sich an, sie ungelesen zu schließen;
ein Bündel je Woche und Sorte ist ein Vorgang, den jemand wirklich liest.
Major-Sprünge kommen bewusst **einzeln** — sie brauchen einen Menschen, der die
Migrationsnotiz liest, und dürfen kein Bündel aufhalten.

### 2. Das Präfix folgt der Wirkung, nicht der Gewohnheit

| Was | Präfix | Warum |
|---|---|---|
| Laufzeit-Abhängigkeit | `fix(deps)` | hebt die Patch-Stelle — eine ausgelieferte Bibliothek zu tauschen *ist* eine Änderung am Produkt |
| Entwicklungswerkzeug | `chore(deps)` | hebt nichts; davon erreicht den Nutzer nichts |
| GitHub Actions | `ci(deps)` | dito, und es benennt die Stelle |
| Basis-Images | `build(deps)` | dito |

### 3. Der Bericht bleibt ein Bericht

`scripts/audit-report.sh` sperrt weiterhin nicht. Er beantwortet **eine** Frage
— „ist eine Meldung dazugekommen?" — und scheitert hart nur, wenn er *gar
nicht messen konnte*. Der Unterschied zwischen „keine Meldung" und „nicht
gemessen" ist der Grund, warum es das Skript gibt.

### 4. Was bleibt, wird begründet — nach Erreichbarkeit, nicht nach Schwere

Eine Meldung bleibt nur mit einem Satz stehen, der sagt, **warum**. Der Maßstab
ist nicht die Punktzahl des Anbieters, sondern ob die verwundbare Stelle von
dieser Anwendung aus erreichbar ist.

Heute steht genau eine, und sie ist zweifach unerreichbar:

> **`uuid` <11.1.1** über `exceljs` — „Missing buffer bounds check in **v3/v5/v6**
> when **`buf`** is provided" ([GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)).
> `exceljs` ruft an seinen zwei Fundstellen `uuidv4()` **ohne Argument** auf
> (`lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js:43` und `:77`) — weder die
> betroffene Funktion noch der betroffene Parameter. `exceljs@4.4.0` ist die
> neueste Fassung und pinnt `uuid: ^8.3.0`; erreichbar wäre die Behebung nur
> über eine erzwungene Major-Überschreibung.
>
> **Neu bewertet, wenn `exceljs` sich bewegt** — das ist der Auslöser, und
> Dependabot ist derjenige, der ihn meldet.

## Consequences

**Gut:**

- Die Grundlinie fiel am Tag dieser Entscheidung von **acht auf eine** Meldung,
  ohne eine einzige erzwungene Überschreibung: sieben lagen im erlaubten
  Bereich, zwei davon über einen Patch der Prisma-CLI (7.9.0 → 7.9.1, das
  `@prisma/dev` 0.24.17 mit den behobenen Fassungen zieht).
- Neue Meldungen haben ab jetzt einen Weg nach draußen, der nicht davon
  abhängt, dass jemand daran denkt.
- Der Versionssprung eines Abhängigkeits-PRs ist vorhersagbar statt zufällig.

**Preis und Grenzen — benannt:**

- **Wöchentliche PRs wollen bearbeitet werden.** Ein Bündel, das vier Wochen
  offen liegt, ist schlechter als keines: es verdeckt das nächste.
- **`catalog:` ist ungemessen.** Die geteilten Fassungen (React, Zod,
  TypeScript …) stehen in `pnpm-workspace.yaml`, nicht in einer
  `package.json`. Ob Dependabot sie anfasst, wird der erste Montag zeigen;
  bleibt der Katalog stehen, ist er Handarbeit — und der Audit-Bericht bleibt
  das Netz darunter.
- **Compose-Dateien liest Dependabot nicht.** Die Fassung des TLS-Frontdoors
  steht in `docker-compose.prod.yml` und bleibt Handarbeit
  (`.github/dependabot.yml` sagt es an Ort und Stelle).
- **Ein grüner Bericht heißt nicht „sicher".** Er heißt: keine *gemeldete*
  Lücke in einer *direkt oder transitiv aufgelösten* Fassung.
