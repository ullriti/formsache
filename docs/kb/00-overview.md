# Projektüberblick

- [Projektüberblick](#projektüberblick)
  - [Worum es geht](#worum-es-geht)
  - [Was die Arbeit an diesem Projekt prägt](#was-die-arbeit-an-diesem-projekt-prägt)
  - [Stack](#stack)
  - [Wegweiser](#wegweiser)

## Worum es geht

Eine Dachorganisation und ihre Mitgliedsorganisationen wickeln wiederkehrende
Formalitäten über Zettel und E-Mail ab: Anmeldung zu Veranstaltungen,
Bestandsmeldung, Sterbefallmeldung, Berichte der Organisationen. **Formsache**
ersetzt das durch eine mandantenfähige Web-Plattform: Bearbeiter bauen
Formulare per Drag-&-Drop, Teilnehmer füllen sie **ohne Login** aus, Antworten
sind auswertbar und exportierbar, Benachrichtigungen laufen automatisch mit
Versandprotokoll.

**Mandantenfähig** heißt: jede Organisation ist ein eigener Organisation mit eigenem
Erscheinungsbild und eigener OIDC-Anbindung; die Daten der Organisationen sind strikt
getrennt. Der Betreiber ist selbst ein Organisation, ein **Superadmin** legt Organisationen
an — Self-Service-Signup gibt es bewusst nicht.

**Kein Ziel:** öffentliches SaaS für Dritte, native Mobile-App,
Bezahlfunktionen, Mitgliederverwaltung über die Formularnutzung hinaus,
Offline-Fähigkeit.

## Was die Arbeit an diesem Projekt prägt

1. **Das UI folgt festen Design-Tokens.** Farben, Abstände und Typografie
   kommen ausschließlich aus den CSS-Variablen in `apps/web/src/styles/`.
   Bestehende Views sind die Vorlage für neue.
2. **Formulare sind dynamisch, Rechte sind es nicht.** Formular-Schema und
   Antworten liegen als **JSONB**; relational bleibt alles, was Isolation,
   Rechte und Zählung braucht.
3. **Sicherheit ist serverseitig.** Organisations-Grenze und Rechte werden in der
   Guard-Kette durchgesetzt und durch Tests belegt; UI-Zustände sind Komfort.
4. **Eine Validierungswahrheit.** Die Zod-Schemas in `packages/shared` gelten
   für Client (Bedienung) und Server (Wahrheit) gleichermaßen.
5. **Hosting-agnostisch.** Alles Umgebungsabhängige kommt aus
   Umgebungsvariablen oder aus den Systemeinstellungen.
6. **Moderate Last, hohe Korrektheitsanforderung.** ~50 Organisationen, ~20 parallele
   Ausfüllende, ~5 Bearbeitende. Skalierung ist kein Thema — Korrektheit unter
   Parallelität (Teilnehmerlimits) sehr wohl.

## Stack

Durchgängig TypeScript in einem pnpm-Monorepo: `apps/web` (React 19 + Vite,
eigene Komponenten, Theming über CSS-Variablen, Pointer-Drag-&-Drop),
`apps/api` (NestJS auf Node 22, REST/OpenAPI, Prisma auf PostgreSQL,
Session-Cookies + Argon2id, OIDC je Organisation, DB-basierte Mail-Queue) und
`packages/shared` (Zod-Schemas, Typen, Kernlogik). Tests mit Vitest,
Testcontainers und Playwright; Betrieb über Docker Compose, CI mit GitHub
Actions und GitVersion.

## Wegweiser

| Frage | Wo |
|-------|-----|
| Wie ist das System aufgebaut? | [`01-architecture.md`](01-architecture.md) |
| Wie starte ich es lokal? | [`04-build-run.md`](04-build-run.md) |
| Wie installiere und betreibe ich es? | [`09-betrieb.md`](09-betrieb.md) |
| Warum dieser Stack? | [ADRs](../architecture/) |
| Wie arbeite ich hier mit? | [`CONTRIBUTING.md`](../../CONTRIBUTING.md) |
