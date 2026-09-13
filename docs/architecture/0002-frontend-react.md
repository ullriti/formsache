# 2. Frontend: React 19 + Vite + TypeScript (statt Angular)

- **Status:** accepted
- **Date:** 2026-07-26

## Context

Das UI war als verbindlicher High-Fidelity-Prototyp vorgegeben, gebaut React-artig
(Component-Klasse mit `state`/`setState`, `createElement`-Aufrufe) mit eigenem
Design-Token-System (CSS-Variablen je Tenant) statt einer Komponentenbibliothek.
In PR #1 stand Angular zur Diskussion, und nach Abwägung wurde React
bestätigt.

## Decision

Frontend wird mit **React 19 + Vite + TypeScript** umgesetzt; Server-State via
TanStack Query, Builder-State via Zustand; eigene schlanke Komponenten,
Theming über CSS-Variablen; Drag-&-Drop mit Pointer-Events (kein HTML5-DnD).

## Consequences

- Struktur und Logik des Prototyps sind nahezu 1:1 portierbar — weniger Aufwand
  und geringeres Risiko, vom Hifi-Design abzuweichen.
- Dünne Framework-Schicht passt zur pixelnahen Custom-UI; Ökosystem
  (TanStack Query, Zod-Integration, Headless-Patterns) ist am reifsten.
- Kein Angular trotz NestJS im Backend: stilistische Nähe hätte keinen
  fachlichen Gegenwert für den Portierungsaufwand gebracht.
- Team/Nachfolger müssen React-Kenntnisse mitbringen.
