# 32. Benachrichtigungs-Vorlagen gehören jeder Organisation, nicht der Installation

- **Status:** accepted
- **Date:** 2026-09-14

## Context

Die Benachrichtigungs-Vorlagen (die drei mitgelieferten Texte, aus denen der
Editor einer Benachrichtigung „Bestätigung an Teilnehmer", „Meldung ans Büro"
und „Änderungsmeldung" anbietet) standen bis zu dieser Entscheidung
installationsweit auf `system_setting.notification_templates`
([ADR-0011](0011-systemweite-einstellungen.md) §7, ausgebaut zum Schreibweg
mit [ADR-0022](0022-erstinbetriebnahme.md), Fortschreibung 2026-08-18). Eine
Zeile, ein Zähler, eine Route hinter `SuperadminGuard` —
`GET`/`PUT /admin/system-settings/notification-templates` —, gelesen von jeder
Organisation gleichermaßen.

Issue #35 verlangt das Gegenteil: **„Vorlagen in den
Organisationseinstellungen anstatt Systemeinstellungen verwalten."** Auf
Nachfrage hat der Melder bestätigt, dass eine bloße Override-Schicht über
einer fortbestehenden Systemvorgabe nicht gemeint ist — der volle Wechsel des
Eigentums an die Organisation, mit dem Verlust der installationsweiten Vorgabe
als bewusstem Preis.

Das widerspricht ADR-0011 §7 und dessen Folgearbeit ausdrücklich: dort steht,
die Vorlagen „ziehen später hierher" (in die Systemzeile) und werden „kopiert
statt vererbt", und die Zusage der Allowlist gilt nur, solange „kein
fachlicher Pfad die Zeile schreibt". Eine Entscheidung, die eine der drei dort
genannten Eigenschaften bricht, „braucht eine neue Entscheidung" — das ist
diese hier.

**Warum jetzt eine eigene Organisationsansicht wichtiger ist als eine
gemeinsame Vorgabe:** Anders als beim Mailserver oder der KI-Konfiguration ist
der Wortlaut einer Benachrichtigung Text, den eine Organisation an ihre
Teilnehmenden schickt — Anrede, Tonfall, was über die Organisation gesagt wird.
Eine geteilte Vorgabe „für alle passend" trifft selten zu, sobald mehr als
eine Handvoll Organisationen eine Installation teilen; die einzige Organisation,
die etwas ändern wollte, musste bisher den Superadministrator bitten. Der
Aufwand einer eigenen Vorlagenzeile je Organisation (eine Migration mit
Backfill, ein neuer Zähler, eine neue Route) ist einmalig; der Nutzen — jede
Organisation kann sofort selbst formulieren — trägt dauerhaft.

## Decision

### 1. Eine Spalte auf `tenant`, nicht eine neue Tabelle

`tenant.notification_templates` (`Json?`) und
`tenant.notification_templates_revision` (`Int @default(1)`) — genau das
Muster, das `branding_revision` und `legal_revision` auf derselben Zeile schon
tragen: ein per-Organisation-Dokument mit eigenem optimistischem Zähler, kein
gemeinsamer mit den übrigen Blöcken der Zeile, aus demselben Grund, den
`legal_revision` dafür nennt — verschiedene Reiter, verschiedene Schreiber,
und ein gemeinsamer Zähler beantwortete „jemand anderes war schneller" auch
dann mit ja, wenn die andere Änderung etwas völlig anderes betraf.

**Verworfen: eine eigene Tabelle `tenant_notification_template` mit
`tenant_id`-Fremdschlüssel und einer Zeile je Vorlage.** Das wäre die Form, die
diese Anwendung für Listen mit eigenem Lebenszyklus wählt (`form_template`,
`notification` selbst) — und genau das sind Benachrichtigungs-*Vorlagen*
nicht: sie sind ein einziges, geschlossenes Dokument (höchstens
`NOTIFICATION_TEMPLATE_LIMIT` Einträge, mit einem `PUT`, das das ganze
Dokument ersetzt, nie ein `PATCH` auf eine Zeile), exakt wie
`tenant.legal_pages` zwei Seiten in einem Dokument hält statt in zwei Zeilen.
Eine Tabelle hätte eine Frage aufgeworfen, die das bestehende Muster gar nicht
kennt — Sortierung, Nebenläufigkeit beim Anlegen zweier Zeilen — für einen
Vorteil (einzelne Zeilen adressierbar), den keine Anforderung verlangt.

### 2. Voller Umzug, keine Override-Schicht — die Systemzeile und ihre Route entfallen

`system_setting.notification_templates`,
`notification_templates_revision`, `SystemNotificationTemplatesAdminService`,
`NotificationTemplatesService` (der alte, installationsweite Leser) und die
Route `GET`/`PUT /admin/system-settings/notification-templates` sind entfernt,
nicht nur unbenutzt gelassen. Der Melder von Issue #35 hat das ausdrücklich
bestätigt.

**Verworfen: die Systemzeile bleibt als Vorgabe für neu angelegte
Organisationen, änderbar bleibt nur die Organisation selbst.** Zwei Wahrheiten
für dieselbe Frage — „was bietet der Editor an?" — hätten früher oder später
auseinanderlaufen können, und der Superadministrator behielte eine Sonderrolle
(„die Installationsvorgabe pflegen"), die niemand mehr braucht, sobald jede
Organisation ihre eigene editiert. §3 unten (Neuanlage) beantwortet „was
bekommt eine frische Organisation" ohne diese Schicht.

### 3. „Kopiert, nicht vererbt" bleibt — nur der Kopierzeitpunkt wandert

ADR-0011 §7 nennt die Benachrichtigungs-Vorlagen als Beispiel für „kopiert,
nicht vererbt": eine Vorlage wird beim Anwenden in die Benachrichtigung
kopiert, und eine spätere Änderung der Vorlage rührt keine bestehende
Benachrichtigung mehr an. Diese Regel gilt unverändert — sie steht jetzt
zusätzlich eine Ebene höher: **jede Organisation** startet mit einer Kopie der
ausgelieferten Vorgabe (`NOTIFICATION_TEMPLATES_FLOOR` in
`packages/shared/src/notification-templates.ts`), editierbar von dem Moment an
unabhängig von jeder anderen Organisation und von der Installation selbst.

- **Bestehende Organisationen** werden von der Migration
  `20260914130000_tenant_notification_templates` befüllt: jede Zeile bekommt
  den Inhalt der damaligen `system_setting`-Zeile, oder die ausgelieferte
  Vorgabe, wo dort nichts entschieden war (`SELECT … LIMIT 1` mit `COALESCE`).
  Der eigene Zähler jeder Organisation beginnt bei `1` — der Beginn einer
  eigenen, unabhängigen Bearbeitungsgeschichte, keine Fortsetzung der
  installationsweiten.
- **Neu angelegte Organisationen** bekommen dieselbe ausgelieferte Vorgabe
  direkt beim Anlegen (`AdminRepository.createTenant`), genau wie ihr
  Erscheinungsbild die Auslieferungsfarben bekommt — bewusst die
  **entgegengesetzte** Wahl zu `tenant.form_defaults`, das dort absichtlich
  leer bleibt, damit eine spätere Änderung der Vorgabe die Organisation noch
  erreicht (`AdminRepository.createTenant`s eigener Kommentar). Für die
  Benachrichtigungs-Vorlagen gibt es nach diesem ADR **keine** Schicht mehr,
  von der eine Organisation erben könnte — „was gilt hier?" ist ab der Anlage
  vollständig die Antwort der eigenen Zeile, und diese Zeile muss deshalb
  etwas Brauchbares enthalten, nicht `NULL`.

### 4. Die Route: `GET`/`PUT /tenant/notification-templates`, Reiter *Vorlagen*

Genau die Bauform, die `TenantLegalController` schon für die Rechtstexte
einer Organisation trägt: kein Organisation im Pfad (die Zeile ist immer die
der *aktiven* Organisation, aufgelöst durch `TenantScopeGuard` aus einer
tatsächlich gehaltenen Mitgliedschaft — die Grenze ist damit strukturell, nicht
geprüft), Guard-Kette `SessionGuard, TenantScopeGuard, GroupPermissionGuard`,
Berechtigung **`can_manage_settings` allein**.

**Nicht `can_manage_settings` und `can_view_responses` zugleich**, anders als
beim Mailserver einer Organisation (`SmtpConfigController`): wer den Mailserver
einträgt, benennt die Maschine, über die jede Antwort einer Benachrichtigung
läuft — eine Aussage darüber, wer Antworten lesen kann. Eine Vorlage trägt
keine Antwortdaten, nur Text und Platzhalter, die erst eine später gespeicherte
Benachrichtigung mit echten Werten füllt; sie ist näher an einem Rechtstext
(eine Aussage, die die Organisation über sich selbst veröffentlicht) als an
einem Kanal zu personenbezogenen Daten.

Frontend: `apps/web/src/views/tenant-admin/TenantTemplatesTab.tsx`, Adresse
`/admin/templates` — der siebte Reiter der Organisations-Verwaltung, angehängt
wie die sechs davor. Englisch, wie jedes Adresssegment dieser Anwendung
([ADR-0030](0030-englische-url-pfade.md)); die Überschrift des Reiters trägt
„Vorlagen" auf Deutsch, die Adresse ist Code.

### 5. Der Einrichtungsassistent verliert seinen Schritt — ersatzlos

Der Assistent der Erstinbetriebnahme (ADR-0022) hatte einen Schritt
*Benachrichtigungs-Vorlagen* vor Schritt „Erste Organisation" — er bediente
genau die Route, die dieser ADR entfernt, und stand ohnehin an der falschen
Stelle im Ablauf: eine Installation ohne eine einzige Organisation hat nichts,
wofür sie Vorlagen hinterlegen könnte. Der Schritt entfällt ersatzlos; die
Begründung und was an seiner Stelle steht (nichts — Neuanlage genügt) steht in
der [Fortschreibung von ADR-0022](0022-erstinbetriebnahme.md#fortschreibung-2026-09-14-der-schritt-benachrichtigungs-vorlagen-entfällt).

### 6. Was bewusst **nicht** in diesem Paket steht

Der Einrichtungsassistent einer **Organisation** (ADR-0025,
`apps/web/src/views/tenant-setup/`) bekommt **keinen** neuen Schritt für die
Vorlagen. Jede Organisation hat sie ab der Anlage bereits vorbelegt (§3), und
der Reiter der Organisations-Verwaltung ist dauerhaft erreichbar — ein
zusätzlicher, einmaliger Assistentenschritt böte keinen Weg, den der Reiter
nicht ohnehin bietet. Sollte sich zeigen, dass eine Organisation die Vorlagen
im selben Zug wie Erscheinungsbild und Mailserver sehen soll, ist das eine
eigene, später zu treffende Entscheidung — kein Nachtrag zu dieser.

## Consequences

- **Positiv:** eine Organisation formuliert ihre eigenen Benachrichtigungen,
  ohne den Superadministrator zu bitten. Eine geteilte Installation mit
  mehreren Organisationen verschiedener Art (Vereine, Ämter, …) kann jede mit
  ihrem eigenen Wortlaut arbeiten lassen, statt eine für alle passende
  Kompromissformulierung zu erzwingen.
- **Preis:** es gibt keine installationsweite Vorgabe mehr, die ein
  Superadministrator einmal hinterlegt und die neue Organisationen abholen —
  jede Organisation startet mit der ausgelieferten Vorgabe aus
  `packages/shared` und ändert sie selbst, oder lässt es. Wer eine
  installationsweite Formulierung will, ändert
  `NOTIFICATION_TEMPLATES_FLOOR` im Quelltext und liefert neu aus — dieselbe
  bewusste Kostenverschiebung, die ADR-0011 §8 für `SYSTEM_FORM_SETTINGS`
  schon einmal getroffen hat.
- **Preis:** eine zusätzliche Datenbankspalte je Organisation statt einer
  einzelnen Zeile — bei Dutzenden statt Tausenden Organisationen je
  Installation (die Größenordnung, die ADR-0011 §8 schon einmal misst) kein
  spürbarer Unterschied.
- **Unberührt:** ADR-0011 gilt für alles andere auf `system_setting`
  unverändert weiter — Mailserver, Basis-Adresse, KI, Rechtstexte der
  Installation. §7 (Allowlist) trägt für sie aus denselben drei Gründen wie
  zuvor.

## Was dieser ADR nicht entscheidet

| Frage | Adressat | Fällig, wenn … |
|---|---|---|
| Soll der Organisations-Assistent (ADR-0025) einen Schritt für die Vorlagen bekommen? | Produktentscheidung | mehrfach beobachtet wird, dass Organisationen ihre Vorlagen erst spät finden |
| Soll es eine Möglichkeit geben, Vorlagen zwischen Organisationen zu kopieren (z. B. Dachorganisation → Untergliederung)? | Produktentscheidung | eine Installation mit vielen ähnlichen Organisationen das wiederholt von Hand nachbaut |
