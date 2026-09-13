# ADR-0030: Englische URL-Pfade — ein harter Schnitt ohne Weiterleitung

- **Status:** accepted
- **Datum:** 2026-08-24
- **Anlass:** Review-Runde 4 Nr. 8
- **Ersetzt:** die Weiterleitungstabelle `LEGACY_PATHS` aus Befund 16
  (`apps/web/src/router/routes.ts`) — ersatzlos.

## Kontext

Der Befund lautete:

> *„URL Pfade enthalten deutsche Namen (Einladung, Verwaltung, ueberwachung,
> ….) Das widerspricht massiv der Vorgabe."*

Die Vorgabe steht in `AGENTS.md` und in `CONTRIBUTING.md`:

| | Sprache |
|---|---|
| Chat, Dokumentation, **Oberflächentexte** | Deutsch |
| **Code** — Bezeichner, Kommentare, Commit-Nachrichten | Englisch |

Ein Pfadsegment ist ein **Bezeichner**. Es steht in einer `const` neben seinem
Vergleich, es wird von Tests adressiert, es wandert durch die Mailvorlagen des
Servers — und es wird nicht übersetzt, wenn jemand die Oberfläche einmal in
einer zweiten Sprache haben will. Die Einordnung „Adresse gehört zur
Oberfläche" war der Fehler; sie stand so in `routes.ts` („German addresses […]
because a human types them and because the surface of this application is
German") und ist damit widerlegt.

Betroffen waren rund dreißig Segmente in vier Familien:

- die Verwaltung: `/verwaltung/…` mit `erscheinungsbild`, `nutzerrechte`,
  `mailversand`, `papierkorb`, `einrichtung`, `rechtstexte`, `ki`, und darunter
  `system/ueberwachung`, `system/mailserver`, `system/vorlagen`;
- die Formulare: `/formulare/<id>` mit `antworten`, `vorschau`,
  `einstellungen`, `benachrichtigungen`, `nutzerrechte`;
- Einzelseiten: `/profil`, `/versandprotokoll`;
- die öffentlichen: `/impressum`, `/datenschutz`, `/lizenzen`, `/passwort/…`,
  `/einladung/…` und `/o/<kurzname>/{impressum,datenschutz}`.

**Nicht betroffen** waren die drei Ausfüll-Adressen `/f/`, `/a/` und `/e/`: sie
sind einbuchstabig und waren nie deutsch. Der Grund dafür steht unverändert in
`public-urls.ts` — sie werden abgetippt und vorgelesen.

## Entscheidung

**Alle Pfade englisch, und zwar als harter Schnitt: keine Weiterleitung.**

Die Zuordnung im Ganzen:

| bisher | jetzt |
|---|---|
| `/verwaltung/erscheinungsbild` | `/admin/appearance` |
| `/verwaltung/formular-standards` | `/admin/form-defaults` |
| `/verwaltung/nutzerrechte` | `/admin/members` |
| `/verwaltung/mailversand` | `/admin/mail` |
| `/verwaltung/ki` | `/admin/ai` |
| `/verwaltung/rechtstexte` | `/admin/legal` |
| `/verwaltung/einrichtung` | `/admin/setup` |
| `/verwaltung/papierkorb` | `/admin/trash` |
| `/verwaltung/system` | `/admin/system` |
| `/verwaltung/system/ueberwachung` | `/admin/system/monitoring` |
| `/verwaltung/system/mailserver` | `/admin/system/mail` |
| `/verwaltung/system/vorlagen` | `/admin/system/templates` |
| `/verwaltung/system/ki` | `/admin/system/ai` |
| `/verwaltung/system/rechtstexte` | `/admin/system/legal` |
| `/formulare/<id>` | `/forms/<id>` |
| `/formulare/<id>/antworten` | `/forms/<id>/responses` |
| `/formulare/<id>/vorschau` | `/forms/<id>/preview` |
| `/formulare/<id>/einstellungen` | `/forms/<id>/settings` |
| `/formulare/<id>/benachrichtigungen` | `/forms/<id>/notifications` |
| `/formulare/<id>/nutzerrechte` | `/forms/<id>/members` |
| `/versandprotokoll` | `/mail-log` |
| `/profil` | `/profile` |
| `/impressum`, `/o/<kurzname>/impressum` | `/imprint`, `/o/<kurzname>/imprint` |
| `/datenschutz`, `/o/<kurzname>/datenschutz` | `/privacy`, `/o/<kurzname>/privacy` |
| `/lizenzen` | `/licences` |
| `/passwort/<token>` | `/password/<token>` |
| `/einladung/<token>` | `/invitation/<token>` |

`/barrierefreiheit` ist keine Zeile dieser Tabelle: die Seite ist in derselben
Review-Runde ersatzlos gestrichen worden (Nr. 4, ADR-0028 Fortschreibung).

Die Segmente stehen weiterhin **an einer Stelle**: die öffentlichen in
`@formsache/shared` (`public-urls.ts`, `legal.ts`), weil der Server dieselben
Adressen als absolute Links in Mails baut; die angemeldeten in
`apps/web/src/router/routes.ts`, weil sie in keiner Mail vorkommen.

### Warum ohne Weiterleitung

Die Alternative lag auf dem Tisch und ist erprobt: `LEGACY_PATHS` hat nach
Befund 16 fünf alte Adressen der Systemverwaltung weitergeleitet, und der
Mechanismus funktionierte. Der Nutzer hat trotzdem den harten Schnitt gewählt,
und die Gründe tragen:

1. **Eine Tabelle, die nur wächst.** Jede weitere Umbenennung legt eine Zeile
   dazu, und keine wird je wieder entfernt — es gäbe keinen Zeitpunkt, an dem
   man sicher sagen kann, dass niemand mehr das alte Lesezeichen hat.
2. **Zwei Wahrheiten je Adresse.** Die Weiterleitung wurde an **zwei** Stellen
   gelesen (`parseRoute` beim Lesen, damit die richtige Ansicht sofort steht,
   und `AppShell` danach, damit sich die Adresszeile heilt). Beides ist nötig
   und beides ist Code, den es ohne die Tabelle nicht gibt.
3. **Die Installationen sind zählbar.** Formsache ist zum Selbsthosten
   gedacht, es gibt keinen Bestand fremder Betreiber, den eine
   404-Seite überraschen könnte.

### Was der Schnitt kostet, ausdrücklich benannt

⚠️ **Bereits verschickte Einladungs- und Kennwortlinks laufen ins 404.** Sie
tragen `/einladung/<token>` bzw. `/passwort/<token>`.

Was **nicht** passiert: die Token verfallen nicht. Sie liegen unverändert in
`password_reset_token`, und die Route dahinter
(`POST /api/auth/password-reset/confirm`) ist unberührt — es muss niemand ein
Konto neu anlegen. Wer aktualisiert, verschickt offene Einladungen noch einmal;
für einen Kennwortlink genügt „Passwort vergessen".

Öffentliche Ausfüll-Adressen (`/f/`, `/a/`, `/e/`) sind nicht betroffen. Das
ist die Grenze, an der der harte Schnitt aufgehört hätte, vertretbar zu sein:
diese Adressen stehen in Mails an **Teilnehmende**, die von einer Aktualisierung
nichts wissen und niemanden fragen können.

## Folgen

- `redirectTarget()` und `LEGACY_PATHS` sind fort, mitsamt dem Effekt in
  `AppShell`, der die Adresszeile geheilt hat. `usePath()` ist damit modulintern
  geworden — außerhalb von `use-route.ts` liest niemand mehr den rohen Pfad.
- Der Inhalt bleibt deutsch. Eine englische Adresse macht keine englische
  Oberfläche: `/imprint` trägt weiterhin die Überschrift „Impressum", und die
  Rechtstexte selbst sind unverändert deutsch. Das ist genau die Trennung, die
  `AGENTS.md` zieht.
- Wer eine Zeile der Tabelle oben ändert, ändert sie an genau einer Stelle im
  Code — und sucht danach in `e2e/` und `apps/web/**/*.test.tsx` nach ihrem
  alten Wort, wie es die Warnung an `SYSTEM_AI_PATH` schon länger verlangt.

## Nachtrag: der Wächter, ohne den es wieder passiert

Die erste Fassung dieses ADR endete mit der Umstellung. Das war zu wenig, und
die CI hat es sofort gezeigt: neun Playwright-Fälle blieben rot, weil die
Umstellung ein Muster benutzt hatte, das ein Unterpfad-Segment nur hinter einem
wörtlichen `/formulare/` fand. Wo eine Interpolation davorstand
(`${formPath}/nutzerrechte`) oder die Schrägstriche escaped waren
(`/\/forms\/[^/]+\/vorschau$/u`), blieb das deutsche Wort stehen.

Das war der kleinere Teil des Problems. Der größere ist die Frage, warum es
überhaupt so weit kam:

> **Die Regel stand als Prosa.** „Code ist englisch" in `AGENTS.md` und in
> `CONTRIBUTING.md` — und Prosa lässt keinen Bau scheitern. Jedes einzelne
> deutsche Segment kam unauffällig herein, mit einer Route, über die niemand
> zweimal nachdachte. Auffällig war erst die Summe, Monate später, beim Lesen
> der Adresszeile.

Eine zweite Prosazeile hätte daran nichts geändert. Deshalb steht die
**vollständige Menge der Adress-Segmente** jetzt in
`apps/web/src/router/address-segments.test.ts`, aufgezählt und einzeln
lesbar. Der Test sammelt sie, indem er jeden Pfadbauer **aufruft** — eine
getippte Liste von Adressen wäre die zweite Wahrheit gewesen, und genau die
läuft auseinander.

Er prüft drei Dinge, und keines davon ist „ist dieses Wort englisch": das kann
kein Test.

1. **Jedes gebaute Segment steht in der Liste.** Ein neues macht ihn rot, mit
   dem Wort in der Meldung. Wer es einträgt, liest es dabei — und zwar bevor
   die Adresse in einem Lesezeichen steht.
2. **Jedes Wort der Liste baut noch eine Adresse.** Sonst beschriebe die Liste
   eine Anwendung, die es nicht mehr gibt; `barrierefreiheit` wäre nach dem
   Streichen der Seite genau so stehen geblieben.
3. **Kleinbuchstaben, Ziffern, Bindestrich.** Billig und fängt immerhin das
   Umlaut-Ersatzwort: `ueberwachung` wäre durchgekommen, `überwachung` nicht.

Derselbe Handel, den `templateDefects` für die Rechtstexte macht — der Test
weiß nichts über Inhalte, er sorgt nur dafür, dass nichts unbemerkt dazukommt.

**Reproduktion:** `TRASH_PATH` auf `/admin/papierkorb` setzen. Beide Richtungen
werden rot — „papierkorb" ist neu, „trash" baut nichts mehr.
