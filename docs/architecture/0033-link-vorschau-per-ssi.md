# 33. Link-Vorschau öffentlicher Adressen per SSI an der Haustür

- **Status:** accepted
- **Date:** 2026-10-03

## Context

Wer die öffentliche Adresse eines Formulars (`/f/<Adresse>`) in WhatsApp,
Signal, Teams oder einer Mail teilt, bekommt eine Vorschau-Karte. Die baut der
Messenger aus `<title>` und den Open-Graph-Angaben (`og:title`,
`og:description`, `og:site_name`) des **ausgelieferten** Dokuments, und zwar
ohne JavaScript auszuführen.

Formsache ist eine Single-Page-Anwendung. Das ausgelieferte Dokument ist für
jede Adresse dasselbe `index.html` mit `<title>Formsache</title>`. Den
Formulartitel setzt erst React (`AppShell`, `document.title`), und den sieht
ein Messenger nie. Jede geteilte Umfrage hieß in der Vorschau deshalb
„Formsache".

Erwogen wurden:

1. **Serverseitiges Rendern** der Anwendung. Das wäre ein Umbau von Build und
   Auslieferung für fünf Zeilen im `<head>`.
2. **Die API liefert `index.html` für `/f/` selbst.** Dann müsste das gebaute
   Dokument ins API-Image, und zwei Images müssten im Gleichschritt bleiben.
3. **nginx `sub_filter` mit Werten aus Antwort-Kopfzeilen** (`auth_request`).
   Kopfzeilen tragen kein verlässliches UTF-8, und ein Fehler des
   Unteraufrufs sperrt die Seite.
4. **SSI an der Haustür.** nginx kann das schon (`ngx_http_ssi_module` ist im
   offiziellen Image), und `index.html` bleibt das eine gebaute Dokument.

## Decision

**Option 4.** Für genau die nackte öffentliche Adresse
(`^/f/<Slug-Alphabet>{1,200}/?$`) schaltet die nginx-Vorlage SSI ein. Die
SSI-Befehle in `index.html` holen über eine interne Location den
Kopf-Ausschnitt `GET /api/public/forms/<Adresse>/link-preview` und setzen ihn
an die Stelle des Titels.

1. **Die API rendert den Ausschnitt** (`apps/api/src/public/link-preview.ts`):
   `<title>`, `og:title`, `og:site_name` (die Organisation), `og:type` und,
   falls vorhanden, `description`/`og:description` aus der Einleitung der
   ersten Seite, auf eine Zeile gebracht und auf 200 Zeichen gekürzt. Jeder
   Wert wird **dort** escaped, nirgends sonst.
2. **Nur ausfüllbare Formulare verraten ihren Titel.** Unbekannt, nie
   veröffentlicht, gelöscht, in gelöschter Organisation (alles über dieselbe
   Ladeabfrage wie das Ausfüllen), nach Fristende und bei erreichtem
   Antwortlimit: Die Antwort ist der schlichte Titel „Formsache", byte-gleich
   für alle diese Fälle. Ein Formular, das **noch nicht offen** ist, behält
   seinen Titel. Solche Links werden absichtlich vorab geteilt.
3. **Hinter einem Zugangswort** erscheinen Titel und Organisation, sonst
   nichts. Das ist dieselbe Linie, die der gesperrte Stub von
   `GET /public/forms/:slug` zieht: Titel ja, Definition nein, und **keine
   Aussage zur Verfügbarkeit**. Deshalb wird die Sperre vor Frist und Limit
   entschieden. Andernfalls ließe sich durch wiederholtes Abfragen der
   Vorschau beobachten, wann ein geschütztes Formular schließt oder voll ist.
4. **Jeder Fehler endet beim schlichten Titel.** Die Route antwortet immer 200.
   Die interne Location `/_link-preview/<Adresse>` macht aus jedem Fehler des
   Unteraufrufs (429 der Ratenbegrenzung, eine nicht erreichbare API) ein
   leeres 204, und `index.html` setzt bei leerer Antwort `<title>Formsache</title>`.
5. **Der Ausschnitt hat eine harte Obergrenze von 8 KiB**
   (`LINK_PREVIEW_MAX_BYTES`), und der Puffer des Unteraufrufs ist doppelt so
   groß. Wird die Grenze überschritten, fällt zuerst die Beschreibung weg,
   dann alles außer dem schlichten Titel. Der Unteraufruf schickt weder das
   Session-Cookie noch `Accept-Encoding` mit.
6. **Außerhalb dieser Location sind die SSI-Befehle Kommentare.** Andere
   Adressen, `vite dev` und `vite preview` liefern das Dokument wie bisher mit
   dem Titel aus dem else-Zweig.

## Consequences

- Jeder Aufruf von `/f/<Adresse>` kostet eine zusätzliche Abfrage gegen die
  API, unter derselben Ratenbegrenzung wie das Lesen des Formulars
  (`PUBLIC_READ_RATE_LIMIT`, eigener Zähler je Route). Kommen die Abrufe eines
  Messengers aus wenigen Adressbereichen, kann er bei großen Installationen an
  diese Grenze stoßen. Er sieht dann „Formsache", sonst passiert nichts.
- **Gemessen, nicht angenommen** (2026-10-03, nginx 1.29 mit einem
  API-Doppel):
  - Der SSI-Parameter `stub` taugt nicht als Rückfall: nginx gibt einen
    Stub-Block wörtlich aus, ohne die SSI-Befehle darin auszuführen. Deshalb
    gibt es `include … set=` mit anschließendem `if`.
  - Ein Prosa-Kommentar in `index.html`, der die SSI-Syntax zitierte, wurde
    als Befehl gelesen und erzeugte einen Fehler im Log. In `index.html` steht
    die Zeichenfolge deshalb nur in den fünf Befehlen selbst.
  - nginx-SSI kennt kein verschachteltes `if`.
  - **Eine Antwort über `subrequest_output_buffer_size` scheitert nicht
    sauber.** nginx protokolliert „too big subrequest response" und schneidet
    das **ganze Dokument** mitten im `<head>` ab, mit Status 200; das Formular
    bleibt weiß (4216 Bytes gegen die Vorgabe von einer Speicherseite).
    Erreichbar ist das mit zulässigen Eingaben, weil Escaping ein `"` auf sechs
    Bytes aufbläht. Daher die Obergrenze unter Nr. 5.
- Die E2E-Läufe laufen gegen `vite preview` und sehen SSI nicht. Belegt wird
  der Weg deshalb an drei Stellen: im Integrationstest der Route
  (`apps/api/test/public/link-preview.spec.ts`), im statischen Test der beiden
  Texte (`packages/shared/src/link-preview-ssi.test.ts`) und im Rauchtest
  (`scripts/smoke.sh`, Zusage 3), den der `stack`-Job gegen den echten
  Container fährt.
- Ein Betreiber mit eigenem Webserver statt der mitgelieferten Haustür
  bekommt weiterhin „Formsache" als Vorschau, aber keinen Fehler.

## Was dieser ADR nicht entscheidet

- **Ein Vorschaubild (`og:image`).** Das Logo der Organisation wäre der
  naheliegende Kandidat. Es braucht aber eine absolute, öffentlich abrufbare
  Adresse und eine Größe, die Messenger annehmen. Das ist eine eigene
  Entscheidung.
- Vorschauen für andere Adressen (Bearbeiten-Link, Entwurfs-Adresse). Diese
  tragen eine Berechtigung im Pfad und werden nicht geteilt.
