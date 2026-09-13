# Architektur

- [Die Teile](#die-teile)
- [Warum alles unter /api liegt](#warum-alles-unter-api-liegt)
- [Die Guard-Kette](#die-guard-kette)
- [Die öffentlichen Pfade](#die-öffentlichen-pfade)
- [Der Weg einer Absendung](#der-weg-einer-absendung)
- [Vier Nähte](#vier-nähte)
- [Was von außen hereinkommt](#was-von-außen-hereinkommt)
- [Hintergrundläufe](#hintergrundläufe)
- [Frontend](#frontend)

Die *Begründungen* stehen in den [ADRs](../architecture/README.md); hier steht
die Karte darüber.

## Die Teile

```
                    ┌─────────────────────────────────────────┐
  Browser ─────────▶│  web  ·  nginx-Frontdoor + React-Bundle │
                    │        /api/* wird durchgereicht         │
                    └───────────────────┬─────────────────────┘
                                        │  (kein Rewrite)
                    ┌───────────────────▼─────────────────────┐
                    │  api  ·  NestJS auf Node 22             │
                    │  Guards → Controller → Services         │
                    └───┬────────────────┬────────────────┬───┘
                        │                │                │
                ┌───────▼──────┐  ┌──────▼─────┐  ┌───────▼──────┐
                │  PostgreSQL  │  │ Dateiablage│  │  SMTP / OIDC │
                │  Prisma      │  │ FILE_      │  │  KI-Anbieter │
                │  + JSONB     │  │ STORAGE_DIR│  │              │
                └──────────────┘  └────────────┘  └──────────────┘
```

Dazu ein `migrate`-Dienst, der einmalig `prisma migrate deploy` fährt. TLS und
die Erreichbarkeit von außen liegen beim Reverse-Proxy des Betreibers
([`09-betrieb.md`](09-betrieb.md)).

**Drei Workspaces, ein Repository** (ADR-0006):

| Workspace | Rolle |
|---|---|
| `apps/web` | React 19 + Vite. Views, Builder, öffentliches Ausfüllen |
| `apps/api` | NestJS. Routen, Guards, Prisma, Mail-Warteschlange, Hintergrundläufe |
| `packages/shared` | Zod-Schemas und Kernlogik — **von beiden** benutzt, aus der Quelle konsumiert (ADR-0007) |

## Warum alles unter /api liegt

Das Session-Cookie ist `SameSite=Lax` und hostgebunden. Die Weboberfläche
reicht `/api` deshalb an die API weiter — in der Entwicklung über den
Vite-Proxy, im Betrieb über den nginx-Frontdoor, **ohne Rewrite**. Beide Wege
sehen dieselbe Adresse; läge die API auf der Wurzel, bräuchte einer von beiden
eine Umschreibung, und umgeschriebene Pfade sind die Stelle, an der Cookie-Pfade
und Weiterleitungen anfangen, sich zu widersprechen.

## Die Guard-Kette

Autorisierung steht in Guards, nie verstreut in Controllern. Jedes Glied kann
nur **wegnehmen**:

| # | Guard | Fragt |
|---|---|---|
| 1 | `SessionGuard` | Gibt es eine gültige Sitzung? (sonst 401) |
| 2 | `TenantScopeGuard` | Welcher Organisation gilt diese Anfrage? (sonst 403) |
| 3 | `GroupPermissionGuard` | Trägt die Gruppe dieser Mitgliedschaft das nötige Recht? |
| 4 | `FormRestrictionGuard` | Wurde der Zugriff auf **dieses** Formular entzogen oder die Rolle herabgestuft? |

Dazu quer: `CsrfGuard` über jede angemeldete Mutation, `SuperadminGuard` für
die installationsweiten Routen, `AiFeatureGuard` für die KI-Routen.

**Drei Sicherheitsentscheidungen darin:**

1. **Der Geltungsbereich kommt aus den Mitgliedschaften**, nie aus
   `session.active_tenant_id` allein — sonst wäre das Schreiben dieser Spalte
   selbst der Grenzübertritt.
2. **Der Formular-Parameter des vierten Glieds wird benannt, nicht geraten** —
   eine Route, die ihn nicht benennt, wird abgelehnt statt durchgelassen.
3. **Ein Fehler beim Lesen von Einstellungen schließt** (*fail closed*): ein
   unlesbar gespeichertes Formular gilt als geschützt, nicht als offen.

Jede dieser Regeln hat einen Integrationstest, der den **unerlaubten** Zugriff
scheitern sieht.

## Die öffentlichen Pfade

`/f/<slug>` (ausfüllen), `/e/<token>` (Entwurf fortsetzen), `/a/<token>`
(Antwort bearbeiten) und die Datei-Routen sind **ohne Anmeldung erreichbar**.
Für sie gilt eine eigene Ordnung: Rate-Limits je Adresse ⊕ Formular,
Payload-Grenzen, Positivliste über den Dateiinhalt statt über die Endung,
serverseitige Schema-Validierung — und Antworten, die byte-gleich sind, wo sie
sonst zum Orakel würden.

`apps/api/src/public/` ist der Ort dafür; die Grenzen stehen als Konstanten in
`packages/shared/src/file-limits.ts` und `packages/shared/src/file-types.ts`.

Ohne Sitzung schreibt außerdem `POST /api/setup` — **nur**, solange `user` leer
ist, und die Bedingung steht in derselben Transaktion wie der Schreibvorgang
(ADR-0022). Es bleibt bei dieser einen: der Einrichtungsassistent meldet sich
danach gewöhnlich an, alle weiteren Schritte laufen hinter `SuperadminGuard`.

## Der Weg einer Absendung

```
POST /api/public/forms/:slug/responses
  │
  ├─ Rate-Limit (Adresse ⊕ Formular)                        → 429
  ├─ Formular auflösen: veröffentlicht? Frist? Zugangswort?  → 409 / 401
  ├─ Antwort gegen die veröffentlichte FormVersion prüfen (Zod, shared)
  │
  └─ EINE Transaktion:
       ├─ Antwortlimit zählen und schreiben
       ├─ Veranstaltungsplätze belegen (SELECT … FOR UPDATE)
       ├─ response-Zeile schreiben, Anlagen zuordnen
       ├─ Entwurf löschen
       └─ mail_log-Zeilen einreihen — Rumpf JETZT gerendert
  │
  └─ Bestätigungsdokument zurück (Titel, Text, Bearbeiten-Adresse)

später, entkoppelt: der Mail-Worker nimmt die Zeilen aus mail_log
```

Zwei Eigenschaften, die den Aufbau erklären: **ein toter Mailserver hält die
Anmeldung nicht auf** (die Mail ist eine Zeile, kein Aufruf — ADR-0004), und
**der Rumpf steht beim Einreihen fest** (eine später geänderte Vorlage schreibt
keine bereits zugesagte Bestätigung um).

## Vier Nähte

| Naht | Wo | Warum sie eine ist |
|---|---|---|
| **Geteilte Validierung** | `packages/shared` | Formular-Schema, bedingte Logik und Antwortprüfung existieren **einmal**. Der Client prüft für die Bedienung, der Server für die Wahrheit — gegen dasselbe Schema |
| **Dateiablage** | `apps/api/src/files/` | `put`/`open`/`remove`. Heute ein lokales Verzeichnis; ein zweiter Adapter fährt gegen **denselben** Vertragstest |
| **Mail-Versand** | `apps/api/src/mail/` | Warteschlange in der Datenbank, Versandidentität je Organisation, unteilbar (ADR-0004, ADR-0013) |
| **KI** | `apps/api/src/ai/` | Zwei Anbieter hinter einer Naht; ohne hinterlegten Schlüssel gibt es die Funktion nicht — die Route antwortet 404, die Anwendung startet (ADR-0015) |

## Was von außen hereinkommt

**Nichts wird angenommen, ohne geparst zu werden.** Fremddaten kommen als
`unknown` herein und gehen durch ein Zod-Schema — Anfragen, Umgebungsvariablen
(`packages/shared/src/env.ts`, mit einer Fehlermeldung, die die Variable nennt)
und die Antworten der KI-Anbieter.

Die Gegenrichtung gilt ebenso: was zur **Laufzeit** änderbar sein muss (SMTP,
Basis-Adresse, KI-Konfiguration), steht in den Systemeinstellungen und nicht in
der `.env` — sonst kostet jede Änderung ein Deployment. Die Grenze zwischen
beidem steht in [`09-betrieb.md`](09-betrieb.md).

## Hintergrundläufe

**Sieben** Läufe buchen in `job_run` — eine Zeile je Lauf, bei Erfolg **und**
bei Fehlschlag: der **Mail-Worker** und sechs Zeitgeber (`mail_log`-Purge,
Datei-Purge, Papierkorb- und Entwurfs-Purge, KI-Freitext-Purge,
Sitzungs-Purge, Alarm-Wächter). Maßgeblich ist `JobKind` in
`apps/api/prisma/schema.prisma`.

Ein Lauf, der noch nie erfolgreich war, alarmiert — sonst sähe ein seit dem
ersten Tag scheiternder Purge für die Überwachung gesund aus, während
Löschfristen darüber laufen (ADR-0016).

## Frontend

Funktionskomponenten und Hooks, kein UI-Framework (ADR-0002). Farben, Abstände
und Typografie ausschließlich über Design-Tokens als CSS-Variablen, die die
Organisation zur Laufzeit überschreibt. Routing über die History-API statt über
eine Bibliothek (ADR-0010).

**Zwei Zustandsarten, die nicht vermischt werden:** Server-Zustand über TanStack
Query (`apps/web/src/api/`), Builder-Zustand über Zustand.

⚠️ Eine gescheiterte Hintergrund-Abfrage darf **nie** einen Entwurf ersetzen —
geprüft wird `isError && data === undefined`.

**Zwei Einrichtungsassistenten auf einem Gerüst** (`apps/web/src/wizard/`): die
Erstinbetriebnahme der Installation — ohne Adresse, weil es sie nur gibt,
solange kein Konto existiert — und die Ersteinrichtung einer Organisation unter
`/admin/setup`. Beide sind führend, aber überspringbar; was offen
bleibt, wird **aus dem Zustand abgeleitet** und nicht aus einem Merker über den
Durchlauf (ADR-0022, ADR-0025).
