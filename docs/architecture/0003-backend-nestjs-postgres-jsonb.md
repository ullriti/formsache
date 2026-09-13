# 3. Backend: NestJS + PostgreSQL/Prisma, Formulare & Antworten als JSONB

- **Status:** accepted
- **Date:** 2026-07-26

## Context

Formulare sind dynamische, mehrseitige Strukturen (16 Fragetypen, bedingte
Logik, Validierung), Antworten entsprechend schemalos. Gleichzeitig brauchen
Rechteprüfung, Tenant-Isolation und Veranstaltungs-Teilnehmerlimits verlässliche
relationale Garantien. Skala ist moderat (~50 Tenants, ~20 parallele
Ausfüllende). Validierung soll im Client (UX) und Server (Wahrheit) identisch
sein.

## Decision

**Node 22 + NestJS** (REST + OpenAPI) als Backend; **PostgreSQL + Prisma** als
Persistenz. Formular-Schema und Antworten liegen als **JSONB**
(`form.schema`, `response.answers` mit `schema_version`); relational modelliert
bleibt alles, was Isolation/Rechte/Zählung braucht (u. a. `tenant`,
`membership`, `group`, `form_permission`, `event_registration` für
transaktionale Teilnehmerlimits). Gemeinsame **Zod-Schemas** in
`packages/shared` validieren in Client und Server.

## Consequences

- Dynamische Formulare ohne Schema-Migration je Formularänderung; Antworten
  bleiben über `schema_version` nachvollziehbar.
- Guards/DI in NestJS machen die serverseitige Rechte-Matrix testbar.
- Ein einziges Datenbanksystem (PostgreSQL) für alles — einfacher Betrieb.
- JSONB-Inhalte sind nicht referenziell abgesichert; Konsistenz erzwingen die
  Zod-Schemas und gezielte Normalisierung (z. B. `event_registration`).
