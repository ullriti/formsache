# Module und Zuständigkeiten

- [Module und Zuständigkeiten](#module-und-zuständigkeiten)
  - [Backend](#backend)
    - [Zugang und Grenze](#zugang-und-grenze)
    - [Fachlichkeit](#fachlichkeit)
    - [Verwaltung und Betrieb](#verwaltung-und-betrieb)
  - [Frontend](#frontend)
  - [Geteilt](#geteilt)
  - [Wo Tests liegen](#wo-tests-liegen)
  - [Anlaufstellen für häufige Änderungen](#anlaufstellen-für-häufige-änderungen)

Ein NestJS-Modul je Domäne. Ein Modul steht auch dann in `app.module.ts`, wenn
nur ein anderes Modul es importiert — ein Controller, der den Router nur
erreicht, weil zufällig jemand sein Modul zieht, ist eine Route ohne sichtbare
Anmeldung.

## Backend

`apps/api/src/`

### Zugang und Grenze

| Modul | Zuständig für |
|---|---|
| `auth/` | Anmeldung mit E-Mail und Kennwort (Argon2id), Sitzungen, Abmeldung, CSRF, Passwort-Rücksetzung |
| `auth/oidc/` | Anmeldung über den Identitätsanbieter einer Organisation — PKCE, `state`, Kontobindung an *(Issuer, Subject)* (ADR-0012) |
| `tenancy/` | Die Guard-Kette: Geltungsbereich der Organisation, Gruppenrechte, Formular-Restriktion |
| `groups/` | Gruppen und die sechs Rechte-Schalter |
| `setup/` | Erster Superadministrator: `POST /api/setup` — die eine Route ohne Sitzung, die schreibt — und der Befehl (ADR-0022) |
| `auth/invitation/` | Einladung eines neuen Kontos: Token (7 Tage), fester Systemtext, Absage **vor** dem Anlegen, wenn der Mailserver der Instanz fehlt (ADR-0024) |

### Fachlichkeit

| Modul | Zuständig für |
|---|---|
| `forms/` | Formulare anlegen, lesen, ändern, veröffentlichen, duplizieren; Antworten lesen und exportieren |
| `public/` | Der **ungeschützte** Weg: ausfüllen, Zugangswort, zwischenspeichern, absenden, nach dem Absenden bearbeiten |
| `settings/` | Formular-Einstellungen und ihre Vererbung; `access-word` als eigenes Modul; dazu der Datenschutzhinweis **dieses** Formulars (ADR-0028 Nr. 4) — dasselbe `PUT`, dieselbe Revision, dasselbe Recht `can_manage_form_settings` |
| `notifications/` | Benachrichtigungen je Formular: Auslöser, Empfänger, Platzhalter, Vorschau |
| `mail/` | Die Warteschlange: Worker, Backoff, Transport je Organisation, Testmail |
| `mail-log/` | Das Versandprotokoll als Ansicht — Filter, „↻ Erneut", gerenderte Mail |
| `files/` | Upload, Auslieferung, Storage-Naht, Metadaten-Entfernung; `purge/` räumt verwaiste Anlagen |
| `form-templates/` | Vorlagen und Blöcke — Formular, Seite, Frage |
| `trash/` | Papierkorb und `purge/` für die 30-Tage-Frist |
| `ai/` | KI-Formularerstellung hinter einer Naht, zwei Anbieter, Kontingent je Organisation; `purge/` löscht den Freitext |

### Verwaltung und Betrieb

| Modul | Zuständig für |
|---|---|
| `tenant-admin/` | Was eine Organisations-Admin an ihrer Organisation einstellt — je Gegenstand ein Modul: Erscheinungsbild, Gruppen, Personen (samt „Einladung erneut senden"), OIDC, SMTP, Basis-Adresse, Antwortadresse |
| `system-settings/` | Die installationsweiten Einstellungen — Mail, Benachrichtigungs-Vorlagen und KI, je mit eigenem Revisionszähler |
| `admin/` | Die Superadmin-Sicht über alle Organisationen |
| `observability/` | `job_run`-Buchführung, Alarm-Wächter, Betriebsstatus |
| `health/` | `GET /api/health` (Selbsttest) und `GET /api/health/ready` (fragt die Datenbank) |

**Querschnitt:** `common/` (Rate-Limit, `secret-box` für die verschlüsselten
Spalten, `public-url`), `config/` (Umgebung parsen und benennen, was fehlt),
`prisma/` (der Client als Provider).

## Frontend

`apps/web/src/`

| Ordner | Zuständig für |
|---|---|
| `views/` | Eine Datei je Ansicht (Dashboard, Builder, Antworten, Einstellungen, Benachrichtigungen, Versandprotokoll, Papierkorb, Organisations-Verwaltung, Systemverwaltung) |
| `wizard/` | Das Gerüst beider Einrichtungsassistenten — Schrittliste, Position als Text, Fokusführung. Weiß von Routen und Speichern nichts |
| `views/setup/` | Die sieben Schritte der Erstinbetriebnahme; `steps.ts` trägt je Schritt den Satz, was ohne ihn nicht geht (ADR-0022) |
| `views/tenant-setup/` | Die acht Schritte einer Organisation unter `/admin/setup` und ihre offenen Punkte auf dem Dashboard (ADR-0025) |
| `views/open-items/` | Die Bauform „offener Punkt", die sich Installation und Organisation teilen |
| `builder/` | Der Formular-Builder: Fragekarten, Seitenliste, Eigenschaften, zeigergesteuertes Drag & Drop (Maus **und** Finger), Builder-Store |
| `fill/` | Der öffentliche Ausfüllweg: Feldarten, Zugangswort, Fortschritt, Honeypot, Bestätigung, Weiterleitung |
| `shell/` | Kopfzeile, Navigation, Mobil-Menü, Organisations-Umschalter, KI-Dialog, Fokusfalle |
| `api/` | Die Transportnaht — eine Datei je Gegenstand, `http.ts` trägt CSRF-Header und Fehlerbehandlung |
| `router/` | Adressen über die History-API (ADR-0010) |
| `styles/`, `assets/`, `brand/` | Design-Tokens als CSS-Variablen, Schriften, Produktzeichen |
| `hooks/`, `test/` | Geteilte Hooks; Testhilfen |

## Geteilt

`packages/shared/src/` — die **Wahrheit** für alles, was Client und Server
gleich sehen müssen. Typen werden per `z.infer` abgeleitet, nie parallel
gepflegt:

- **Formular und Antwort:** Schema der sechzehn Feldarten, bedingte Logik,
  Antwort-Validierung, Sonderfälle (Adresse, Matrix, Tabelle, Veranstaltung)
- **Einstellungen:** Vererbungs-Merge, Fristen, Entwurfs-Aufbewahrung
- **Ausgabe:** CSV, Excel, HTML — Format und Spaltenwahl
- **Mail:** Vorlagen, Platzhalter, Escaping, Versandidentität
- **Zeit:** `berlin-time.ts` — deutsche Eingabe, eindeutiger Zeitpunkt,
  Sommerzeitlücke und Wiederholstunde
- **Umgebung:** `env.ts` — das Schema, an dem der Start scheitert oder gelingt
- **KI:** Anbieter, Modell-Listen, Entwurfs-Schema, Nutzungszählung

## Wo Tests liegen

| Sorte | Ort |
|---|---|
| Unit (Kernlogik) | neben der Quelle: `packages/shared/src/*.test.ts` |
| Unit (Komponenten) | neben der Quelle: `apps/web/src/**/*.test.tsx` |
| Integration (API, echte Datenbank) | `apps/api/test/` — je Domäne ein Ordner |
| E2E (Playwright) | `e2e/` — Kern-Flows in zwei Breiten |
| Wächter über den Quelltext | verteilt, z. B. `apps/api/test/observability/log-hygiene.spec.ts` |

Der Schwerpunkt liegt unten: jede Rechte- und Isolationsregel braucht einen
Integrationstest, der den **unerlaubten** Zugriff scheitern sieht.

## Anlaufstellen für häufige Änderungen

| Ich will … | Fange an bei |
|---|---|
| eine neue Feldart | `packages/shared` (Schema + Validierung) → `apps/web/src/builder` → `apps/web/src/fill` → Export |
| eine neue Route | Modul in `apps/api/src/` → Guards benennen → Vertrag in `packages/shared` → `apps/web/src/api/` |
| ein neues Recht | `groups/` und die Guard-Kette → **Negativtest zuerst** |
| eine neue Einstellung | `packages/shared` (Vererbung) → `settings/` → `system-settings/` und `tenant-admin/` |
| einen Schritt in einem Einrichtungsassistenten | `views/setup/steps.ts` bzw. `views/tenant-setup/steps.ts` (`consequence` ist Pflichtfeld) → Schritt-Komponente → wenn ohne ihn etwas **nicht funktioniert**, auch `open-items.ts` |
| einen neuen Hintergrundlauf | `JobKind` erweitern → Buchführung über `apps/api/src/observability/` → Frist in [`10-datenschutz.md`](10-datenschutz.md) |
