# Datenmodell

- [Datenmodell](#datenmodell)
  - [Die vier Entscheidungen](#die-vier-entscheidungen)
  - [Die Landkarte](#die-landkarte)
  - [Die Tabellen](#die-tabellen)
    - [Zugang und Zugehörigkeit](#zugang-und-zugehörigkeit)
    - [Formular und Antwort](#formular-und-antwort)
    - [Benachrichtigung und Versand](#benachrichtigung-und-versand)
    - [Dateien](#dateien)
    - [Einstellungen](#einstellungen)
    - [Rechtstexte](#rechtstexte)
    - [Betrieb](#betrieb)
  - [Verschlüsselte Spalten](#verschlüsselte-spalten)
  - [Migrationen](#migrationen)

Maßgeblich ist `apps/api/prisma/schema.prisma` — dort steht je Tabelle und je
heikler Spalte die Begründung.

## Die vier Entscheidungen

**1. `tenant_id` steht in jeder fachlichen Tabelle.** Jede fachliche Abfrage
nennt die Organisation **in der Bedingung**, nicht erst im Filter danach.
Zusätzlich trägt jede dieser Tabellen `@@unique([id, tenantId])`, auf den die
Kindtabellen ihre Fremdschlüssel legen: `Response` verweist nicht auf `form.id`,
sondern auf `(form_id, tenant_id)`. Eine Antwort der Organisation A kann damit
**datenbankseitig** nicht an einem Formular der Organisation B hängen. Das ist
der Boden unter der Guard-Kette, kein Ersatz für sie.

**2. Formular-Schema und Antworten liegen als JSONB.** `form.draft_schema`,
`form_version.schema` und `response.answers` sind `Json` (ADR-0003). Die
Wahrheit über ihre Gestalt steht in den Zod-Schemas in `packages/shared`; der
Server parst jede dieser Nutzlasten, bevor er sie glaubt.

**3. Eine Antwort hängt an einer unveränderlichen Fassung.**
`form.draft_schema` ist der Arbeitsstand. Veröffentlichen schreibt eine
`FormVersion` — eine Kopie, die nie wieder geändert wird —, und
`form.published_version_id` zeigt darauf. Jede `Response` verweist auf genau
die Fassung, gegen die sie geprüft wurde. Deshalb bleibt die Antwort auf eine
gelöschte Frage lesbar und exportierbar.

**4. Gelöscht heißt zweistufig.** `Tenant`, `Form` und `Response` tragen
`deleted_at` — der Papierkorb, 30 Tage. Danach löscht der Aufräumlauf die
**Zeile**, nicht das Datum ([`10-datenschutz.md`](10-datenschutz.md)), auch die
Bytes hinter einer Anlage. Eine Organisation im Papierkorb nimmt ihren Inhalt
mit: was in *ihrem* Papierkorb liegt, wartet auf **ihre** Frist.

## Die Landkarte

```
Tenant ──┬── Group ── Membership ── User ── Session
         │
         ├── Form ──┬── FormVersion (unveränderlich)
         │          │        ▲
         │          ├── Response ── EventRegistration
         │          │        └── File (kind = attachment)
         │          ├── ResponseDraft ── File
         │          ├── Notification ── MailLog
         │          └── FormPermission
         │
         ├── FormTemplate      (Vorlagen: Formular · Seite · Frage)
         ├── File (kind = crest)
         └── AiUsage

SystemSetting · OpsAlert · JobRun   — installationsweit, ohne tenant_id
```

## Die Tabellen

### Zugang und Zugehörigkeit

| Tabelle | Trägt |
|---|---|
| `tenant` | Eine Organisation samt Erscheinungsbild, OIDC-Konfiguration, eigenem SMTP-Block, Basis-Adresse, KI-Kontingent — und `deleted_at` |
| `user` | Eine Person, die sich anmeldet. Ein Konto ist installationsweit, nicht je Organisation |
| `group` | Eine Gruppe **innerhalb einer Organisation**, mit den sechs Rechte-Schaltern (ADR-0021) |
| `membership` | `user ↔ tenant` samt der Gruppe, aus der die Rechte kommen. Wer in zwei Organisationen ist, hat zwei Zeilen |
| `session` | Serverseitige Sitzung hinter dem `httpOnly`-Cookie (ADR-0005) |
| `password_reset` | Ein einmaliger Link, `kind` trennt die beiden Sorten: Rücksetzung (1 Stunde) und **Einladung** (7 Tage). Gespeichert ist nur der SHA-256 des Werts |

**Ein lokales Konto darf ohne Passwort dastehen**, solange seine Einladung
offen ist (ADR-0024). Der CHECK `user_local_or_oidc` verbietet seither nur noch
die eine Form, die keine ist: Passwort **und** Anmeldedienst am selben Konto.

**Rechte hängen an der Mitgliedschaft, nicht am Konto.** Der Organisations-Umschalter
setzt `session.active_tenant_id`, aber der Geltungsbereich wird aus den
Mitgliedschaften abgeleitet und nie aus dieser Spalte allein.

### Formular und Antwort

| Tabelle | Trägt |
|---|---|
| `form` | Titel, Status (`draft`/`published`), Arbeitsstand als JSONB, öffentlicher Slug, abschnittsweise Einstellungs-Überschreibung |
| `form_version` | Unveränderlicher Schnappschuss der Definition, fortlaufend nummeriert je Formular |
| `response` | Eine Einreichung: Antworten als JSONB, Verweis auf die Fassung, `edit_token` für den Bearbeiten-Link |
| `event_registration` | Die Plätze, die **eine** Antwort in **einer** Veranstaltung belegt — eigene Zeilen, weil die Obergrenze transaktional gehalten wird |
| `response_draft` | Ein zwischengespeicherter Entwurf. **Keine Antwort:** zählt nicht gegen Limits, belegt keine Plätze, steht nicht im Export |
| `form_template` | Eine gespeicherte Vorlage der Organisation — immer eine **Kopie**, ohne Papierkorb |

### Benachrichtigung und Versand

| Tabelle | Trägt |
|---|---|
| `notification` | Die Konfiguration je Formular: Auslöser, Format, Empfänger, Betreff, Rumpf mit Platzhaltern |
| `mail_log` | **Eine Zeile je Empfänger und Versuch** — Status, Versuche, Backoff-Zeitpunkt, Versandidentität. Zugleich die Warteschlange (ADR-0004) |

Zwei Spalten, die man kennen muss: der Rumpf wird **beim Einreihen**
festgeschrieben, und `failed_at` — nicht `created_at` — trägt den Alarm über
gescheiterte Nachrichten.

### Dateien

`file` ist der **Index** von etwas, das außerhalb der Datenbank liegt
(ADR-0014). Die Bytes liegen im Verzeichnis aus `FILE_STORAGE_DIR`; ein
`pg_dump` allein ist deshalb keine Sicherung (ADR-0017).

`kind` entscheidet, wie eine Datei ausgeliefert werden darf (`attachment` vs.
`crest`), `status` trennt „die Zeile gibt es" von „die Bytes liegen". Beide
Spalten sowie `tenant_id` und `form_id` sind **unveränderlich** — ein
Datenbank-Trigger verhindert, dass ein `UPDATE` eine fremde Anlage in ein Logo
umschreibt.

### Einstellungen

| Schicht | Wo | Wer setzt sie |
|---|---|---|
| Organisation | `tenant.form_defaults` | Organisations-Admin |
| Formular | `form.settings_override` | wer Einstellungen darf |

Gelesen wird **abschnittsweise**: ein Abschnitt steht entweder auf
„Organisations-Standard" oder auf „Angepasst"; was eine Organisation nicht
entschieden hat, ist die ausgelieferte Vorgabe `SYSTEM_FORM_SETTINGS` in
`packages/shared` (ADR-0011).

**Es gibt vier Abschnitte.** *Verfügbarkeit* (Öffnungszeitraum, Frist, Zeit- und
Teilnehmerlimit) steht **nur** am Formular — eine organisationsweite Frist
schlösse Anmeldungen, die niemand angesehen hat.

### Rechtstexte

Drei Spalten, drei Reichweiten, **ein** Dokumentformat
(`legalDocumentSchema` in `packages/shared`: `mode`, `fills`, `conditions`,
`custom`, `link`) — und drei Fassungen je Seite: die ausgefüllte **Vorlage**,
ein **eigener Text** oder ein **Verweis** auf eine Seite, auf der der Text schon
steht. Alle drei Hälften stehen immer nebeneinander; ein Moduswechsel verliert
nichts (ADR-0028 Fortschreibung 2026-09-07).

| Spalte | Reichweite | Wer setzt sie |
|---|---|---|
| `system_setting.legal_pages` | die Installation — Impressum, Datenschutz | Superadministrator |
| `tenant.legal_pages` | eine Organisation — Anbieterangaben, Datenschutzhinweise | `can_manage_settings` |
| `form.privacy_notice` | **ein Formular** — Zweck, Rechtsgrundlage, Aufbewahrung | `can_manage_form_settings` |

Die dritte gibt es, weil Art. 13 Abs. 1 lit. c DSGVO Zweck und Rechtsgrundlage
**je Verarbeitung** verlangt und ein Formular eine Verarbeitung ist (ADR-0028
Nr. 4). `NULL` heißt „nichts hinterlegt"; öffentlich erscheint dann **nichts**
an dieser Stelle — die allgemeinen Hinweise der Organisation stehen einen Link
weiter und können genügen.

Die ersten beiden tragen je einen eigenen Revisionszähler (`legal_revision`),
die dritte **keinen**: sie wird auf derselben Seite und mit demselben `PUT`
gespeichert wie die Einstellungen des Formulars, also beschreibt
`form.settings_revision` genau die Kollision, die dort auftreten kann.

⚠️ **In allen drei Spalten steht Klartext, niemals Auszeichnungssprache.** Was
daraus an Struktur wird, entscheidet allein die Positivliste in
`packages/shared/src/legal-text.ts`, auf dem Server, beim Ausliefern —
ausgeliefert werden Blöcke, nie eine Zeichenkette (ADR-0028 Abschnitt 7).

⚠️ **Was ausgeliefert wird, hängt von der Zielgruppe ab** (`LegalAudience`,
ADR-0028 Fortschreibung 2026-09-05). Öffentlich entfällt jede **Zeile**, in der
eine Angabe fehlt, und der Zustand der Seite reist nicht mit; die Vorschau im
Editor zeigt beides. Am gespeicherten Dokument ändert das nichts — dieselbe
Zeile, zwei Ausgaben.

`system_setting` trägt keine Formular-Standards, sondern nur, was keine
Umgebungsvariable ist: SMTP-Block, Basis-Adresse, `reply_to`, Alarm-Adresse und
die KI-Konfiguration samt verschlüsseltem Schlüssel. Mail und KI tragen **je
einen eigenen** Revisionszähler: zwei Seiten pflegen dieselbe Zeile, und ein
gemeinsamer Zähler meldete „jemand war schneller" auch dann, wenn die andere
Seite etwas völlig anderes angefasst hat.

Die Benachrichtigungs-Vorlagen standen bis
[ADR-0032](../architecture/0032-benachrichtigungs-vorlagen-je-organisation.md)
ebenfalls hier. Seitdem trägt sie `tenant.notification_templates`, mit
`notification_templates_revision` als eigenem Zähler neben
`branding_revision` und `legal_revision` — jede Organisation hat ihr eigenes
Dokument, kopiert aus der damaligen Systemzeile bzw. der ausgelieferten
Vorgabe.

### Betrieb

`job_run` (eine Zeile je Hintergrundlauf, bei Erfolg **und** Fehlschlag),
`ops_alert` (wann zuletzt über eine Kennzahl alarmiert wurde und ob sie
quittiert ist — von wem, bis wann, warum) und `ai_usage`
(ein KI-Aufruf, mit **zwei** Lebensdauern — Freitext 30 Tage, Personenbezug
12 Monate).

## Verschlüsselte Spalten

Vier Werte liegen mit `SECRET_BOX_KEY` versiegelt in der Datenbank: das
Zugangswort eines geschützten Formulars, das SMTP-Passwort, das
OIDC-Client-Secret je Organisation und der KI-Schlüssel.

⚠️ **Eine Sicherung ohne den passenden Schlüssel ist unvollständig.**
`scripts/restore.sh` warnt **vorher**, wenn der Schlüssel nicht zum Archiv
passt.

## Migrationen

Versioniert unter `apps/api/prisma/migrations/`, **nie nachträglich editiert**.
Angewandt ausschließlich mit `prisma migrate deploy` — im Container-Stack durch
den `migrate`-Dienst.

Dass die Migrationen das Schema reproduzieren, ist gemessen:
`prisma migrate diff --from-config-datasource --to-schema` meldet „No
difference detected", als Gegenprobe in der CI.
