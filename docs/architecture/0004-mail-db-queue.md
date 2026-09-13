# 4. E-Mail-Versand über DB-basierte Queue (kein Redis/Broker)

- **Status:** accepted
- **Date:** 2026-07-26

## Context

Benachrichtigungen (Teilnehmer/intern) müssen zuverlässig versendet, protokolliert
(90 Tage), bei Fehlern erneut versendet werden können — das Versandprotokoll ist
eine eigene fachliche Anforderung. SMTP-Server ist reine Konfiguration
(hosting-agnostisch). Die Last ist gering; zusätzliche Infrastruktur (Redis,
Message-Broker) wäre für den Betrieb ein unnötiger Kostenfaktor.

## Decision

Versand mit **Nodemailer** über konfigurierbares SMTP. Die ohnehin geforderte
Tabelle **`mail_log` dient zugleich als Warteschlange**: Einträge entstehen mit
Status `queued`, ein Worker versendet mit Retry/Backoff und setzt
`sent`/`failed`; „Erneut senden" setzt zurück auf `queued`. Purge nach 90 Tagen.

## Consequences

- Kein zusätzliches Infrastruktur-System; Queue-Zustand ist per SQL einsehbar
  und identisch mit dem geforderten Protokoll.
- At-least-once-Semantik mit einfachem Locking (`FOR UPDATE SKIP LOCKED`) reicht
  für die Größenordnung.
- Bei stark wachsender Last wäre ein Broker nachrüstbar (Schnittstelle Worker ↔
  Queue bleibt intern gekapselt).

## Fortschreibung 2026-08-15: eine Mail hat eine Hülle (Review-Befunde 31 und 34)

- **Status:** accepted
- **Date:** 2026-08-15
- **Ersetzt:** nichts an der Warteschlange. Ergänzt, **wie** eine zugestellte
  Mail aussieht, und schreibt dabei eine Entscheidung fort, die in
  `packages/shared/src/mail-template.ts` stand und nicht in dieser ADR.

### Was fortgeschrieben wird

An `renderAnswerTable` stand bis heute der Satz: *„Rendered without styling
beyond `border-collapse` — how a notification looks is the template author's
business, and inline styles here would be a design decision baked into a shared
package."* Er ist in sich schlüssig und hat sich nicht bewährt. Der Nutzer hat
zwei Befunde dagegen gestellt:

- **Befund 31** — die Standardvorlagen und die Systembenachrichtigungen sehen
  nicht aus wie Post einer Organisation, sondern wie ein HTML-Fragment ohne
  Rahmen: kein `<html>`, kein `<head>`, kein Zeichensatz, keine Breite.
- **Befund 34** — die Änderungsansicht (`{{aenderungen}}`) ist „sehr schwer zu
  lesen": eine randlose Dreispaltentabelle `Frage | Bisher | Neu`, die ein
  Telefon auf drei Spalten à hundert Pixel zusammenfaltet.

Drei Gründe, warum der alte Satz nicht trug:

1. **Für das, was dort gerendert wird, gibt es keinen Vorlagenautor.**
   `{{antworten}}` und `{{aenderungen}}` sind Tabellen *dieser* Anwendung; ein
   Bearbeiter kann sie setzen oder weglassen, nicht gestalten. „Der Autor
   entscheidet" hieß in Wahrheit „niemand entscheidet".
2. **Eine Mail hat keinen Ort, an dem ein Autor gestalten könnte.** Es gibt kein
   Stylesheet, das ein Mailclient sicher lädt. „Keine Inline-Styles" ist in einer
   Mail gleichbedeutend mit „keine Gestaltung".
3. **Ein Rumpf ohne Hülle ist kein Dokument.** Ohne `<meta charset>` entscheidet
   der Client über den Zeichensatz; ohne `viewport` und ohne gedeckelte Breite
   entscheidet er über das Layout.

### Entscheidung

**1. Es gibt eine Hülle, und sie entsteht beim Zustellen.**
`wrapMailHtml` (`packages/shared/src/mail-template.ts`) macht aus dem
gespeicherten Rumpf ein vollständiges Dokument: `<!doctype>`, `<head>` mit
Zeichensatz und Viewport, eine zentrierte Karte fester Höchstbreite (600 px),
ein 4 px hoher Streifen in der Organisationsfarbe, eine Fußzeile mit dem Namen
der Organisation. Gelegt wird sie in `QueuedBodyRenderer` — dem einen Trichter,
durch den jeder zugestellte Rumpf geht, und durch den auch die Detailansicht des
Versandprotokolls liest.

*Warum beim Zustellen und nicht beim Einreihen:* `mail_log.body_html` hält, was
eine Bestätigung **zusagt** — Worte, Antwortwerte, Datum. Die Hülle sagt nichts
zu, sie ist Rahmen. Beim Zustellen gelegt, bekommt sie jede Mail (auch die
Systemmails, die ihren Rumpf ganz woanders schreiben), zeigt das
Versandprotokoll genau das Zugestellte, und die Organisationsfarbe muss nicht
durch drei Module des Einreihpfads gereicht werden. Der Preis ist benannt: ändert
eine Organisation ihre Farbe, während eine Mail in der Warteschlange liegt, geht
sie in der neuen Farbe hinaus — richtig für einen Rahmen, falsch wäre es für
eine Zusage.

**2. Kein Bild, nirgends.** Kein `cid:`-Anhang, kein Logo, kein Produktzeichen —
eine Festlegung des Nutzers. Ein eingebettetes Bild bräuchte die
Anhänge-Mechanik des Transports, wird von vielen Clients erst auf Nachfrage
geladen und ist ein bekannter Grund für Zustellprobleme. Was die Mail von der
Organisation zeigt, ist ihre Farbe und ihr Name.

**3. Die Organisationsfarbe geht durch dasselbe Prädikat wie auf dem
Bildschirm.** `isBrandColor` (`branding.ts`, `#rrggbb`) — es ist laut seiner
eigenen Dokumentation „the single predicate behind both gates", und ein
`style`-Attribut in einer Mail ist das dritte. Ein Wert, der nicht durchkommt,
kostet die Farbe und nicht die Mail.

**4. Die Änderungsansicht ist eine Karte je geänderter Frage, nicht mehr eine
Dreispaltentabelle.** Gestapelt statt nebeneinander, damit ein Umbruch *einen*
Wert trifft und nicht das Raster. Jede Seite trägt **zwei** Signale: „Bisher"
grau und durchgestrichen, „Neu" dunkelgrün und fett — und beide ihr Wort
daneben, damit die Zuordnung ohne Farbe lesbar bleibt (WCAG 1.4.1; ein
invertierender Dunkelmodus nimmt genau dieses eine Mittel weg). Die Textfassung
ist mitgewandert: Frage in einer eigenen Zeile, darunter beide Werte mit bündig
ausgerichteten Beschriftungen, Folgezeilen eingerückt, Leerzeile zwischen den
Einträgen.

**5. E-Mail-HTML, nicht Web-HTML.** Tabellenlayout statt Flexbox (Outlook
rendert mit der Word-Engine), Inline-Styles statt `<style>`-Block (Gmail und
einige Webmailer werfen ihn weg), keine Webfonts, kein `var()`, kein
`color-mix()`, Breite gedeckelt, `color-scheme: light only` ausgesprochen. Die
Anwendung legt sich auf **ein** Farbschema fest und sagt es den Clients, die es
lesen; die anderen invertieren trotzdem, und dagegen hilft nur die Wahl mittlerer
Grautöne statt reinem Schwarz auf reinem Weiß.

**6. Die Standardvorlagen tragen kein `<p>` mehr.** Der Vorlageneditor ist eine
Textarea, und `renderMailTemplate` weiß das: jeder Zeilenwechsel in literalem
Text wird zu einem `<br />`. Stand der Text zusätzlich in Absätzen, zählte der
Abstand doppelt. Die Rümpfe sind jetzt Text mit ein wenig Auszeichnung — genau
die Fassung, die in der Textarea so aussieht, wie sie ankommt. **Die Renderregel
selbst bleibt unangetastet**: einen Zeilenwechsel „zwischen zwei Blockelementen"
zu unterdrücken nähme auch die Leerzeile weg, die ein Bearbeiter absichtlich
zwischen zwei `<p>` gesetzt hat. Eine Vorlage zu ändern kostet eine Datei; eine
Renderregel zu ändern kostet jede Vorlage jeder Installation.

### Folgen

- Die Marken, die erst beim Zustellen gefüllt werden (`{{bearbeiten}}`,
  Rücksetz-Link, ADR-0020), sind **unberührt**: sie werden vor dem Einhüllen
  eingesetzt, die Hülle enthält keine Marke und verschiebt keine. Ein Test hält
  die Reihenfolge fest.
- Die Detailansicht des Versandprotokolls zeigt jetzt das vollständige Dokument
  im `sandbox=""`-Rahmen — also das, was hinausging.
- **Offen und benannt:** die Vorschau im Benachrichtigungs-Editor
  (`apps/web/src/views/notifications/NotificationPreview.tsx`) rendert weiterhin
  den nackten Rumpf und zeigt die Hülle nicht. Sie wird damit ungenauer, als sie
  war. Der saubere Weg ist derselbe Aufruf dort, mit der Akzentfarbe aus der
  Sitzung.
