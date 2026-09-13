# 14. Datei-Upload — eine Naht, zwei Listen, zwei Wege

- **Status:** accepted
- **Date:** 2026-07-31

## Context

Der Datei-Upload ist nicht ein zehnter Fragetyp. Er bringt vier Dinge auf
einmal, die diese Anwendung sonst nicht hat: **einen Speicher außerhalb der Datenbank**, **einen öffentlichen
Schreibpfad, der Bytes annimmt**, **eine Datei, die Fremde ohne Sitzung
ausgeliefert bekommen** (das Logo), und **eine Datei, die niemand außerhalb einer Organisation sehen darf** (die Anlage zu
einer Antwort). Jedes davon hat eine eigene Fehlermöglichkeit, und drei davon
sind erst nach dem Vorfall sichtbar.

Der strittigste Teil ist vorentschieden: **zwei getrennte Positivlisten, weil es
zwei Auslieferungsarten sind.** Dieser ADR schreibt das aus (Nr. 5) und
entscheidet daneben, was dort offen blieb: Speicherform, Grenzen, Verweis,
Abruf, Aufräumen, Rate-Limit.

**Dieser ADR ist ein Prüfobjekt, kein Freibrief.** Er folgt deshalb einer
Schreibregel: **wo „X kann nicht passieren" steht, steht der Mechanismus
daneben, der es verhindert**, und wo etwas nur angenommen ist, steht es als
**Annahme** markiert (A1–A7, am Ende gesammelt).

Was dieser ADR **nicht** ändert: die Guard-Kette, die Regel „jede Obergrenze,
die fremder Verkehr erreichen kann, ist ein Hebel", und die Hosting-Agnostik aus
[`CONTRIBUTING.md`](../../CONTRIBUTING.md) — S3 als Vorgabe ist ausdrücklich
verworfen, die Vorgabe ist ein lokales Volume.

---

## Decision

### 1. Eine Naht, drei Methoden, ein gemeinsamer Vertragstest

`FileStorage` ist ein Interface plus DI-Token in `apps/api/src/files/`, mit
genau drei Methoden:

```ts
put(key: string, source: Readable, opts: { maxBytes: number }): Promise<{ bytes: number }>
open(key: string): Promise<Readable>
remove(key: string): Promise<void>   // idempotent
```

Zwei Implementierungen: `LocalFileStorage` (Verzeichnis) und
`InMemoryFileStorage` (Test-Doppel). **Beide bestehen denselben Vertragstest**,
und der ist der eigentliche Ertrag dieser Nummer: ein Doppel, das seinen eigenen
Testen genügt, belegt nichts über den Adapter. Der Vertrag enthält mindestens:
`put` über `maxBytes` bricht ab **und hinterlässt nichts** (`open` danach
schlägt fehl); `remove` auf einen unbekannten Schlüssel ist kein Fehler;
`open` auf einen unbekannten Schlüssel ist ein unterscheidbarer Fehler, kein
leerer Strom.

**Bewusst *nicht* im Interface:** `list()`, `exists()`, `move()` und jede Form
von URL-Erzeugung. Kein Verzeichnislisting, weil das Aufräumen (Nr. 15) aus der
**Datenbank** arbeiten muss — ein Listing kennt keinen Tenant und keinen
Eigentümer, und ein Aufräumen, das von der Platte ausgeht, ist ein Löschen ohne
Autorisierungsbegriff. Keine URL-Erzeugung, weil die Adresse einer Datei eine
Entscheidung dieser Anwendung ist (Nr. 9) und keine des Speichers; ein Adapter,
der URLs ausgibt, ist der erste Schritt zu vorsignierten Links, die an der
Guard-Kette vorbei tragen.

`packages/shared` bekommt hiervon **nichts** — die Naht ist serverseitig. Was
geteilt wird, sind die Positivlisten und die Grenzen (Nr. 5, Nr. 6), weil der
Client dieselben Zahlen für seine UX braucht und zwei Schreibweisen genau die
Drift wären, gegen die `pickDefaultColumns` geteilt wurde.

### 2. `FILE_STORAGE_DIR` ist Pflicht ohne Vorgabewert — **der Start scheitert**, es gibt kein `503`

Der Name: **`FILE_STORAGE_DIR`**. Nicht `UPLOAD_DIR` (das Verzeichnis ist auch
die Quelle jedes *Downloads*), nicht `STORAGE_URL` oder ein S3-förmiger Name
.

Beide Wege waren vertretbar; entschieden ist **Start verweigern**, aus vier
Gründen, und der vierte ist der, der es kippt:

1. **Der Präzedenzfall in diesem Repo ist einheitlich.** `DATABASE_URL`,
   `NODE_ENV` und `SECRET_BOX_KEY` sind Pflicht ohne Vorgabewert, und die
   Begründung steht bei jedem: eine Variable, die etwas *entscheidet* statt
   etwas zu *beschreiben*, bekommt keinen Rückfall. `FILE_STORAGE_DIR`
   entscheidet, wohin personenbezogene Anlagen geschrieben werden.
2. **`503` ist die stille Variante.** Die API käme gesund hoch, `/api/health`
   wäre grün, Formulare ließen sich bauen und veröffentlichen — und der erste,
   der es merkt, wäre ein Teilnehmer, der beim Anmeldestart seinen Nachweis
   nicht anhängen kann. Auf diesen Pfad schaut niemand mit einem Monitor.
3. **`503` ist nicht eine Entscheidung, sondern viele.** Antwortet nur der
   Upload mit `503`? Auch der Logo-Abruf? Auch das Lesen eines Formulars, das
   ein hochgeladenes Logo führt? Jede Antwort verteilt eine Bedingung weiter
   durch den öffentlichen Pfad. Ein fehlendes Verzeichnis ist kein Zustand je
   Anfrage.
4. **Die Alternative kostet nichts, was das Projekt nicht ohnehin zahlt** —
   *sofern* das Skript den Wert wirklich hinbekommt, und das ist die Hälfte,
   die im ersten Entwurf fehlte. `scripts/dev-setup.sh` ist laut `CONTRIBUTING.md`
   der Schritt **nach jedem `git pull`**, aber es *erzeugte* nur, was in
   `REQUIRED_SECRETS` steht — **Schlüsselmaterial**, und einen Pfad kann man
   nicht würfeln. Mit „Name + Zweck, kein Beispielpfad" in `.env.example` wäre
   `FILE_STORAGE_DIR=` **leer** in die `.env` gewandert, und die API startete
   nach dem dokumentierten Weg trotzdem nicht: Grund 4 trüge dann gar nichts,
   und die Zusage „ein Skript nach jedem Pull, dann läuft es" wäre für genau
   diese Variable falsch.
   Deshalb, und das ist die Entscheidung: **das Skript bekommt eine zweite,
   kurze Liste** neben `REQUIRED_SECRETS` — `REQUIRED_DIRECTORIES`, ein Eintrag
   je Variable mit dem lokalen Vorgabepfad (`FILE_STORAGE_DIR:var/files`). Sie
   trägt den Pfad in eine `.env` ein, die noch keinen hat, **legt das
   Verzeichnis an** und rührt einen vorhandenen Wert nie an. `.env.example`
   bleibt damit **ohne** Beispielpfad, und das bleibt richtig: ein Pfad dort
   sähe aus wie eine Vorgabe der Anwendung, und ein Server, der ihn übernimmt,
   schriebe personenbezogene Anlagen versehentlich neben den Quelltext.
   Das Zod-Schema hat weiterhin **keinen** `.default()`, und der Adapter legt
   das Verzeichnis zur Laufzeit **nicht** an — beides wäre der stille Rückfall,
   gegen den Grund 1 steht. `.gitignore` trägt `/var/`: das Verzeichnis füllt
   sich beim Entwickeln mit **hochgeladenen Dateien**, und ein `git add -A`
   darüber wäre personenbezogene Post in einem Repository.
   `describeEnvFailure()` nennt die fehlende Variable und dieses Skript beim
   Namen. Der Preis — eine bestehende Installation startet nach diesem Update nicht, bis
   `.env` ergänzt ist — ist real und wird hier ausdrücklich getragen: ein lauter
   Stopp beim Deployment ist billiger als ein leiser während einer Anmeldung.

**Der Adapter prüft zusätzlich beim Start**, dass der Pfad existiert, ein
Verzeichnis ist und beschreibbar (`access(dir, W_OK)`) — derselbe Schnitt wie
`decodeSecretBoxKey()`, das die *Form* des Schlüssels dort prüft, wo die Chiffre
liegt, statt im Schema. Ein Volume, das nicht hochkam, ist damit ein
Startfehler und keine 500 während der einen Stunde, in der es zählt.
**Annahme A1** dazu am Ende: `access(W_OK)` ist ein Rauchtest, keine Garantie.

### 3. Ein `file`-Modell, ein `kind`, und eine `CHECK`-Bedingung statt eines Vorsatzes

Eine Tabelle — ein `file`-Modell —, mit den Eigenschaften:

- **`tenant_id` ist Pflicht auf jeder Zeile** und steht in jeder Query.
- **`kind`** ist Pflicht: `'response_attachment' | 'tenant_logo'`.
- **`form_id`** ist gesetzt genau bei `response_attachment`,
  **`response_id`** ist der Eigentümer und bis zum Absenden `NULL` (Nr. 13).
- **`content_type`** ist der **abgeleitete** Typ aus der Positivliste, nie der
  vom Aufrufer geschickte (Nr. 5, Nr. 12).
- **`file_name`** ist der ursprüngliche Name als *Daten* (Nr. 10).
- **Die Bytes stehen nicht in der Datenbank** — kein `bytea`, kein base64 in
  JSONB.

Die Formkonsistenz ist eine **Datenbank-Bedingung**, kein Prüfschritt im
Service:

```sql
CHECK ((kind = 'response_attachment' AND form_id IS NOT NULL)
    OR (kind = 'tenant_logo'         AND form_id IS NULL AND response_id IS NULL))
```

Das ist dieselbe Bewegung wie [ADR-0013 Nr. 1](0013-versandidentitaet-je-organisation.md):
ein Zustand, den die Anwendung nicht erzeugen kann, soll auch über einen
Rohschreibzugriff nicht ausdrückbar sein. Ein „Logo mit `response_id`" — die
Zeile, mit der man eine fremde Anlage in den öffentlichen Logo-Abruf schöbe —
ist damit kein Test, den jemand vergessen kann, sondern ein
`ERROR: new row violates check constraint`.

**Was diese Bedingung *nicht* ist:** sie prüft eine **Zeilenform**, keine
**Unveränderlichkeit**. Ein
`CHECK` wird bei jedem `INSERT` und jedem `UPDATE` neu ausgewertet — auf der
Zeile, wie sie *danach* aussieht, und nicht gegen die Zeile, wie sie vorher war.

```sql
UPDATE file SET kind = 'tenant_logo', form_id = NULL, response_id = NULL
 WHERE id = '<eine fremde Anlage>';
```

Diese Anweisung **erfüllt** die Bedingung vollständig und schiebt trotzdem
genau das in den öffentlichen Logo-Abruf, wogegen sie geschrieben ist. Der
Weg über `INSERT` ist versperrt, der Weg über `UPDATE` war es nie.

Deshalb kommt ein **Trigger** dazu, und er gehört zu der Änderung, die das
Beanspruchen baut (eigene Migration — die für die Tabelle selbst ist geschrieben und
Migrationen werden nicht nachträglich editiert): `BEFORE UPDATE` auf `file`,
der abbricht, sobald `kind`, `tenant_id` oder `form_id` sich ändern. Die
Anwendung braucht das nie — sie schreibt nach dem Anlegen ausschließlich
`response_id`, `status` und `byte_size` (Nr. 4, Nr. 13) —, und genau deshalb
kostet das Verbot nichts. *Nachweis:* das `UPDATE` oben scheitert, und zwar in
der Datenbank, gemessen über eine rohe Anweisung, nicht über den Service. Ohne
den Trigger gilt hier der engere Satz: die `CHECK`-Bedingung schließt das
Anlegen einer formwidrigen Zeile, nicht ihr Herstellen durch Umschreiben.

**Was die Datenbank hier *nicht* leistet, und das ist die ehrliche Hälfte:**
`response` trägt den zusammengesetzten Fremdschlüssel `(form_id, tenant_id)`,
sodass eine vergessene Bindung an der Datenbank scheitert. Für `file` geht das
**nicht** — Prisma verlangt, dass alle Skalarfelder einer *optionalen* Relation
optional sind, und `tenant_id` ist Pflicht. Es ist wörtlich die Einschränkung,
die `schema.prisma` bei `MailLog.response_id` bereits dokumentiert. Die
Tenant-Grenze von `file` ruht deshalb auf `tenant_id`, der gescopeten Query und
der Beanspruchungsprüfung aus Nr. 13 — **nicht** auf einem Fremdschlüssel. Wer
das für ausreichend hält, hält es aufgrund von Nr. 13 und ihren Tests, nicht
aufgrund des Schemas.

### 4. Zeile zuerst, Bytes danach — und der Schlüssel ist die `id`, nie ein Name

**Reihenfolge:** Signaturprüfung → `file`-Zeile anlegen → `put()` → Zeile auf
`stored` setzen. Nicht umgekehrt.

Der Grund ist die Asymmetrie der beiden Abbruchstellen: eine **Zeile ohne
Bytes** ist sichtbar, aufräumbar und beim Abruf ein sauberer 404. **Bytes ohne
Zeile** sind unsichtbar — die Datenbank ist der Index (Nr. 1 hat `list()`
bewusst nicht), also findet sie niemand wieder, und sie überleben jede
DSGVO-Löschzusage. Der Absturz zwischen zwei Schritten ist die eine Situation, in der man sich die
Richtung aussuchen kann; hier wird sie ausgesucht.

**Der Speicherschlüssel ist die `id` der Zeile** (UUIDv7), gefächert über zwei
Ebenen aus ihrer Hex-Darstellung (`ab/cd/<id>`), damit kein Verzeichnis mit
hunderttausend Einträgen entsteht. **Nicht** der `public_ref` (Nr. 9): ein
Verweis, der auch ein Pfad ist, kann nicht getauscht werden, ohne die Datei zu
bewegen. Und **niemals** der Dateiname (Nr. 10).

Der Adapter weist jeden Schlüssel zurück, der nicht die Form einer UUID hat —
eine Prüfung *an der Naht*, nicht beim Aufrufer, damit ein künftiger zweiter
Aufrufer sie erbt statt sie zu vergessen. Der Test dazu übergibt
`../../../etc/passwd` und erwartet eine Ablehnung, nicht einen normalisierten
Pfad.

### 5. Zwei Positivlisten, geprüft an der Signatur — und SVG steht auf keiner

Ausgeschrieben:

| Liste | Erlaubt | Auslieferung |
|---|---|---|
| **Logo** (`tenant_logo`) | **PNG, JPEG** | öffentlich, **eingebettet** (Nr. 12) |
| **Anlage** (`response_attachment`) | **PDF, PNG, JPEG** | nur mit Sitzung, **nur als Download** (Nr. 13) |

**SVG steht auf keiner von beiden.** Beim Logo unmittelbar: es wird
eingebettet, ein Skript darin liefe im Kontext unserer Seite. Bei der Anlage
mittelbar und deshalb aufzuschreiben: dort hinge der Schutz **allein am
Download-Header**, und eine später gebaute Anlagen-Vorschau — „man will ja
sehen, was hochgeladen wurde" — machte daraus XSS im Origin der Anwendung.
Verworfen sind ferner Office-Formate (ein Makro startet ohne Zutun), weitere
Bildformate und eine Inhaltsprüfung auf aktive Bestandteile (neue Abhängigkeit
im öffentlichen Pfad, und Behörden-PDFs tragen regelmäßig Skript).

**Geprüft wird an der Signatur des Inhalts, an Offset 0**, nicht an der Endung
und nicht am `Content-Type` des Aufrufers — beide gehören dem Hochladenden:

- PNG: `89 50 4E 47 0D 0A 1A 0A`
- JPEG: `FF D8 FF`
- PDF: `%PDF-` — **an Offset 0**, strenger als die PDF-Spezifikation, die den
  Header irgendwo in den ersten 1024 Bytes erlaubt. Absichtlich: genau dieser
  Spielraum ist der Platz, in dem ein Polyglot seinen anderen Kopf trägt.

**Was diese Strenge kostet, benannt statt entdeckt:** ein PDF mit führendem
Leerraum, Zeilenumbruch oder einem UTF-8-BOM vor `%PDF-` wird **abgelehnt**,
obwohl jeder Betrachter es öffnet — und Scanner, Multifunktionsgeräte und
manche Serverbibliotheken erzeugen so etwas. Fachlich ist das der Fall, um den
es hier geht: ein Nachweis kommt regelmäßig aus einem Bürokopierer. Die
Abwägung bleibt trotzdem zugunsten von Offset 0, weil die Alternative — „irgendwo
in den ersten 1024 Bytes" — genau der Spielraum ist, in dem der zweite Kopf
sitzt. Aber sie wird **gemessen, nicht angenommen**: ein Testlauf mit echtem Verkehr
lädt ein **echtes Scanner-PDF** hoch, und wenn es abgelehnt wird, ist das ein
Befund mit Zahlen statt einer Vermutung (**Annahme A7**). Die Ablehnung nennt
den Grund lesbar (der Nachweis) — „diese Datei ist kein PDF" wäre für einen
Teilnehmer, der eins vor sich hat, die falsche Auskunft.

Die Prüfung ist ein Byte-Vergleich auf den ersten acht Bytes des Stroms und
**braucht keine Abhängigkeit** — kein `file-type`, kein `sharp`, kein
Virenscanner. **Annahme A4** dazu am Ende: Magic Bytes belegen den Anfang, nicht
den Rest.

Beide Listen sind **abschließend**. Was fehlt, kommt dazu, wenn jemand es
wirklich braucht — nicht vorsorglich. Die Listen liegen als geteilte Konstante
in `packages/shared`, damit die Auswahl im Browser und die Ablehnung am Server
nicht zwei Meinungen sein können.

*(Der ausgelieferte `assets/beispiel-signet.svg` bleibt unberührt: `TENANT_LOGO_REFS`
ist eine Liste **mitgelieferter** Dateien aus unserem eigenen Bundle. Das Verbot
gilt dem, was Fremde und Organisation-Admins hochladen.)*

### 6. Die Zahlen — und wo jede von ihnen durchgesetzt wird

| Grenze | Wert | Durchgesetzt |
|---|---|---|
| Je Anlage | **10 MiB** | beim Upload, *streamend*, vor dem Schreiben |
| Je Logo | **2 MiB** | beim Upload, *streamend*, vor dem Schreiben |
| Dateien je Antwort | **10** | beim **Absenden** (Nr. 13) |
| Bytes je Antwort | **25 MiB** | beim **Absenden** (Nr. 13) |
| Unbeanspruchte Bytes je Adresse ⊕ Formular | **25 MiB** | beim Upload |
| Unbeanspruchte **Dateien** je Adresse ⊕ Formular | **20** | beim Upload (Nr. 7) |
| Bytes je Adresse und Stunde | **100 MiB** | beim Upload (Nr. 7) |
| **Dateien** je Adresse und Stunde | **60** | beim Upload (Nr. 7) |

**Warum 10 MiB je Anlage.** Eine Anlage ist fachlich fast immer ein Nachweis:
eine Bescheinigung, eine Vollmacht, ein eingescanntes Formular. Ein
Bürokopierer bei 300 dpi liefert dafür 0,5–3 MiB als PDF; ein Handyfoto einer
Bescheinigung (12 MP, JPEG) 3–6 MiB. 10 MiB trägt beides mit Luft und ist klein
genug, dass eine Ablehnung auf einer Mobilverbindung Sekunden kostet und nicht
Minuten.

**Warum 2 MiB je Logo.** Ein Logo ist eine quadratische Grafik, die auf ein
paar hundert Pixel gerendert wird. Das mitgelieferte
`apps/web/src/assets/beispiel-emblem.svg` misst 240 KiB — 2 MiB ist das Achtfache
und damit großzügig für ein Bild, das aus einer Vorlage exportiert wird.

**Warum 10 Dateien und 25 MiB je Antwort.** Die Fachlichkeit sagt eins bis zwei:
eine Anmeldung mit Nachweis, eine Sterbefallmeldung mit Urkunde. Zehn ist weit
darüber und begrenzt trotzdem ein Formular, dem jemand fünfzig Datei-Fragen
gegeben hat. 25 MiB statt der rechnerischen 100 MiB (10 × 10 MiB), weil der
realistische Fall zwei bis drei Scans sind und dieses System kein Archiv ist —
es löst den Weg über die E-Mail ab, und ein Mailanhang ist bei 25 MiB ohnehin am
Ende.

**Warum 20 Dateien im Wartestand und 60 je Stunde.** Zwanzig ist das Doppelte
der zehn aus einer Antwort — Luft dafür, dass jemand dieselbe Frage zweimal
belegt oder die falsche Datei erwischt hat — und `60/h` ist ein Sechstel dessen,
was das Minuten-Limit aus Nr. 8 rechnerisch zuließe. Beide begrenzen, was die
Byte-Zähler nicht begrenzen: **Zeilen und Inodes**, siehe Nr. 7.

**Annahme A5:** diese Zahlen sind aus dem beschriebenen Gebrauch geschätzt, nicht
an echtem Verkehr einer Organisation gemessen. Ein Testlauf mit echtem Verkehr ist die erste
Gelegenheit, sie zu prüfen; sie zu ändern ist eine Konstante und eine Migration
der nginx-Grenze (Nr. 18), nicht eine Bauform.

**Die Grenze greift *vor* dem Schreiben, und das ist keine Formulierung.** Der
Byte-Zähler liegt um den Strom, nicht hinter ihm: `Content-Length` oberhalb der
Grenze wird sofort mit `413` beantwortet, ein fehlender oder lügender
`Content-Length` ändert nichts, weil der Zähler entscheidet und `put()` beim
Überschreiten abbricht und das Angefangene entfernt (Nr. 1). Gemessen wird das
am **Storage-Doppel** (welche Bytes es gesehen hat), nicht an einer HTTP-Antwort
— eine 413 sagt nichts darüber, was vorher auf die Platte lief.

### 7. Was die Menge auf der Platte begrenzt — und was sie nicht begrenzt

**Vier** Zähler, **alle je Adresse**, keiner je Formular oder installationsweit
— und sie kommen paarweise, weil eine Platte zwei Dinge verliert:

1. **Unbeanspruchte Bytes je Adresse ⊕ Formular: 25 MiB.** Eine Adresse kann
   für ein Formular nicht mehr als eine Antwort voll an Bytes im Wartestand
   halten.
2. **Unbeanspruchte Dateien je Adresse ⊕ Formular: 20.** Dieselbe Schlüsselung,
   die andere Dimension.
3. **Bytes je Adresse und Stunde: 100 MiB**, gleitendes Fenster, im Speicher
   des Prozesses, geschlüsselt über `clientAddress` (also IPv6 auf das /64
   reduziert, wie jede andere Grenze dieser Anwendung).
4. **Dateien je Adresse und Stunde: 60**, dasselbe Fenster, derselbe Schlüssel.

**Warum die Anzahl-Dimension überhaupt da ist — die Rechnung dahinter.** Zwei
Zähler, die nur **Bytes** messen, greifen zu kurz: Bytes sind nicht das Einzige,
was eine Platte hat. Eine **8 Byte große Datei**
mit gültigen Magic Bytes (`89 50 4E 47 0D 0A 1A 0A` — ein PNG-Kopf und sonst
nichts) besteht die Positivliste aus Nr. 5 und jede Größengrenze aus Nr. 6; an
zwei reinen Byte-Zählern wäre sie **unbegrenzt oft** durchgegangen: 10 Uploads
je Minute ⊕ Formular (Nr. 8) sind **14 400 Zeilen und 14 400 Inodes je Adresse
und Tag**, während die Byte-Zähler bei rund 115 KiB stünden und nie ansprächen.
Was dann voll ist, ist nicht das Volume, sondern die Inode-Tabelle und die
`file`-Tabelle — und der Purge aus Nr. 15 räumt das zwar nach 24 Stunden ab,
aber der Zulauf ist schneller als die Frist.

Und die naheliegende Gegenmaßnahme ist **nicht** die richtige: eine
**Mindestgröße** verschöbe die Zahl nur. Ein vollständiges, gültiges 1×1-PNG
misst rund 70 Byte, ein gültiges Mini-PDF wenige hundert — eine Mindestgröße,
die diese durchlässt, macht aus 14 400 winzigen Zeilen 14 400 etwas weniger
winzige. Begrenzt wird, was knapp ist: die **Anzahl**.

**Warum keine Obergrenze je Formular, je Organisation oder je Installation:** das ist die
Regel, wörtlich. Jede Obergrenze, die fremder Verkehr erreichen kann,
ist ein Hebel, mit dem ein Dritter die Anmeldung einer Organisation abschaltet — bei
einer Byte-Quote sogar besonders billig, weil man sie mit *gültigen* Uploads
füllt. Ein Zähler je Adresse kostet niemanden das Kontingent eines anderen.

**Und jetzt die Rechnung, die nicht schöngeschrieben wird.** Beanspruchte
Dateien (Nr. 13) fallen aus den Zählern 1 und 2 heraus, sind also nur durch das
begrenzt, was Einreichungen begrenzt: Frist, Antwortlimit und `PUBLIC_SUBMIT_RATE_LIMIT`
(30/min). Ein Formular **ohne** Antwortlimit erlaubt einer Adresse damit
rechnerisch 30 × 25 MiB = 750 MiB/min — Zähler 3 deckelt das auf **100 MiB je
Stunde und Adresse**, und *das* ist die Zahl, die trägt.

**Und weil sie trägt, wird sie begründet statt gesetzt.** 100 MiB je Stunde ist
das Vierfache dessen, was eine vollständige Antwort mit zehn Anlagen kostet
(25 MiB, Nr. 6): eine Adresse darf pro Stunde viermal absenden, was fachlich
schon der äußerste Fall ist — ein Mitglied, der für vier Personen eine
Anmeldung mit Scans einreicht, ist damit versorgt, ein Skript nicht. Nach oben
begrenzt sie derselbe Satz, den `CONTRIBUTING.md` für öffentliche Endpunkte
verlangt: bei 2,4 GiB je Adresse und Tag wäre eine einzelne Adresse ein
Betriebsproblem. **Die Folgegröße, die dazugehört und nicht schöngeschrieben
wird:** die Zahl gilt *je Adresse*. Tausend Adressen sind tausend Kontingente,
also **≈ 100 GB in einer Stunde** — eine Größenordnung, gegen die kein Zähler
dieser Anwendung schützt und gegen die auch keiner schützen kann, ohne der Hebel
aus dem Absatz darüber zu sein. Was dagegen hilft, ist Betrieb (Volumengröße,
Alarm, notfalls die Fristen der Formulare), nicht eine Konstante.

Der verteilte Fall bleibt damit offen, und das ist dieselbe ehrliche
Konsequenz, die `public-forms.rate-limit.ts` für das verteilte Raten des
Zugangsworts bereits benennt, aus demselben Grund getragen: die
Alternative wäre der Hebel.

Was daraus **folgt und keine Fußnote ist**: die Größe des Volumes und seine
Überwachung sind eine Betriebssache, keine Anwendungssache. Und ein
Formular, das öffentlich Dateien annimmt, **sollte ein Antwortlimit setzen** —
das ist eine Empfehlung an die Organisation und keine Zusage der Anwendung.

**Annahme A3:** alle vier Zähler und der Throttler-Speicher sind **prozesslokal**.
Ein horizontal skaliertes Deployment vervielfacht sie — das gilt heute schon für
jede Grenze dieser Anwendung, `docker-compose.yml` fährt einen `api`-Container,
und es ist hier genannt, damit die Zahl nicht als absolut gelesen wird.

### 8. Rate-Limit am Upload: je Adresse ⊕ Formular, **nie** formularweit

**10 Uploads je Minute, je Adresse ⊕ Formular.** Geschlüsselt mit demselben
Mechanismus, den `access-attempt-tracker.ts` für die Zugangswort-Schranke trägt,
einschließlich seines Deckels von 32 Formularen je Adresse und des
Überlauf-Eimers — ohne den ist ein Zähler „je Formular" eine Speicher-Allokation
je erfundenem Slug, und der Rate-Limiter ist selbst der Angriff.

Der Tracker wird **verallgemeinert, nicht kopiert**: eine zweite Abschrift dieser
Begründung ist eine zweite Sache, die wahr bleiben muss. Das berührt
sicherheitsrelevanten Code an anderer Stelle, und dessen Tests bleiben grün oder das Paket
ist nicht fertig.

Zehn, weil ein Formular mehrere Datei-Fragen tragen darf und weil ein Teilnehmer,
der die falsche Datei erwischt hat, noch einmal hochlädt. Der Zähler ist ohnehin
nicht die bindende Grenze — das sind die Zähler aus Nr. 7; zehn ist die Zahl, die
ein unbeaufsichtigtes Skript ausbremst, bevor es dort ankommt.

**Der Logo-Upload** (Organisation-Admin, mit Sitzung) bekommt **keinen** eigenen
Zähler: die Sitzung und die Guard-Kette sind die Schranke, wie bei jeder anderen
Verwaltungsroute. Das ist eine Entscheidung, keine Auslassung.

### 9. Die Form des Verweises: `public_ref`, 16 Byte CSPRNG, base64url

`file.public_ref` — **16 Byte aus `randomBytes`, base64url, 22 Zeichen**, also
Alphabet und Länge des `public_slug` und des `edit_token`.
Eindeutig über die Installation.

**Nicht die `id`.** Die ist UUIDv7 und damit zeitgeordnet; eine zeitgeordnete
Kennung in eine Adresse zu schreiben, die Fremde halten, ist genau die
Eigenschaft, gegen die `Form.publicSlug` eingeführt wurde.

Dazu ein `isFileRef()` nach dem Muster von `isPublicSlug`/`isEditToken`:
`/^[A-Za-z0-9_-]{1,200}$/`, bewusst weiter als 22 Zeichen, damit ein Wechsel der
Byte-Zahl nicht jede bestehende Adresse still auf 404 legt. Beide Hälften
verdienen ihren Platz, und die zweite ist die, die beißt: ein Prozentzeichen ist
dekodiert, bevor die Anwendung es sieht, `%00` kommt als NUL-Byte an, PostgreSQL
lehnt U+0000 in `text` ab, und die Query wirft — eine **500 dort, wo jede
unbekannte Adresse 404 antwortet**, also genau das Orakel, das an anderer Stelle
bereits ausgeschlossen wird.

Die Verteilungsprobe gilt sinngemäß. **Sie gilt sinngemäß und nicht
mehr:** eine Prüfung auf die Byte-Länge fängt einen gepolsterten Zähler
ausdrücklich **nicht** — das wird hier wiederholt, weil es die
Stelle ist, an der ein Test Sicherheit vortäuscht, die er nicht misst.

**Und die Einschränkung, ohne die dieser Absatz eine falsche Zusage wäre:** der
unerratbare Verweis ist **nicht** die Autorisierung der Anlage. Die ist die
Guard-Kette aus Nr. 11. Der Verweis ist der Schutz des **Logos** (das keine
Sitzung hat) und ansonsten Tiefenstaffelung.

### 10. Der Dateiname ist Daten — an zwei Stellen abgesichert, nicht an einer

Der ursprüngliche Name wird gespeichert und angezeigt (der Dateiname gehört als
Link angezeigt). Er wird **nie** Teil eines Pfades (Nr. 4). Zwei
Mechanismen, weil einer an der falschen Stelle stünde:

1. **Beim Schreiben**, durch ein Zod-Schema in `packages/shared`: 1–255 Zeichen
   nach NFC-Normalisierung, keine Steuerzeichen (U+0000–U+001F, U+007F), kein
   `/`, kein `\`, nicht `.` und nicht `..`. Ein Name, der das nicht erfüllt,
   wird abgelehnt — nicht „bereinigt": eine Bereinigung erzeugt eine zweite
   Wahrheit über das, was ein Name ist.
2. **Beim Lesen**, im `Content-Disposition` (Nr. 11): `filename*=UTF-8''<prozent-kodiert>`
   nach RFC 6266, dazu ein konservativer ASCII-Rückfall, in dem alles außerhalb
   `[A-Za-z0-9._-]` ersetzt ist.

Warum beides: Punkt 1 allein verließe sich darauf, dass jede Zeile in der
Datenbank durch Punkt 1 gekommen ist (ein Rohschreibzugriff, ein Seed, eine
Migration sind Gegenbeispiele). Punkt 2 allein verließe sich darauf, dass Node
einen Header mit CR/LF ablehnt — das tut es, aber das ist eine Aussage über eine
Bibliothek, und Sicherheitsaussagen über Bibliotheken altern.

### 11. Zwei Abrufwege, zwei Regeln

**(a) Logo — öffentlich, eingebettet.** `GET /api/public/files/<ref>`, ohne
Sitzung, ratelimitiert je Adresse wie der öffentliche Lesepfad. Liefert
ausschließlich Zeilen mit `kind = 'tenant_logo'`; jede andere Zeile ist ein
404, byte-gleich mit einem erfundenen Verweis.

- `Content-Type`: **fest aus der Logo-Liste abgeleitet** — und „woraus
  abgeleitet" ist ausgeschrieben, weil die Antwort sonst der Zufall ist: der
  gespeicherte `content_type` (der ist *gemessen*, nicht vom Aufrufer geschickt,
  Nr. 5) wird gegen die **Logo**-Liste geschlagen und dient nur als Schlüssel;
  `image/png` → `image/png`, `image/jpeg` → `image/jpeg`, **alles andere → 404**,
  byte-gleich mit einem erfundenen Verweis. Der Fall ist nicht hypothetisch: die
  Anlagen-Liste enthält `application/pdf`, es ist dieselbe Tabelle, und ein
  `tenant_logo` mit `content_type = 'application/pdf'` entstünde durch einen
  Rohschreibzugriff oder einen künftigen dritten Schreibpfad. Ohne diesen Satz
  wäre sein Verhalten undefiniert — „kein Treffer" liefert je nach Bauart einen
  leeren Header, `application/octet-stream` oder den gespeicherten Wert, und
  genau diese Wahl darf nicht dem Zufall der Implementierung gehören. **404,
  nicht 415:** die Route hat genau eine Antwort für „gibt es nicht so", und ein
  eigener Fehlercode wäre wieder ein Orakel.
- `Content-Disposition`: **`inline`**, nicht `attachment`. Das Logo wird
  eingebettet ausgeliefert; `attachment` auf
  einem `<img>`-Subresource funktionierte nur, weil Browser den Header dort
  ignorieren — eine Zusage, die auf Browserverhalten ruht, das wir nicht
  kontrollieren (**Annahme A2**). Der Schutz dieser Route ist deshalb **die
  Liste** (nur PNG/JPEG, kein SVG, kein HTML) plus:
- `X-Content-Type-Options: nosniff` — und diese Zeile ist hier **tragend**, nicht
  Kosmetik: die Datei kommt vom **selben Origin** wie die Anwendung; würde ein
  Browser sie als HTML deuten, wäre das XSS im Origin. `nosniff` ist der
  Mechanismus, der das Deuten verbietet.
- `Cache-Control: no-store` bleibt (der globale `noStore`), **ohne Ausnahme**.
  Das kostet einen erneuten Abruf je Seitenaufruf für ein Bild in der
  Größenordnung von 240 KiB — getragen aus dem Grund, den `no-store.ts` selbst
  aufschreibt: „eine pauschale Regel, die gelegentlich zu streng ist, schlägt
  eine Liste, die gelegentlich zu locker ist". Wer das ändern will, entscheidet
  eigens (siehe „Was dieser ADR nicht entscheidet").

**(b) Anlage — nur mit Sitzung der richtigen Organisation.**
`GET /api/responses/files/<ref>`, hinter der vollständigen Guard-Kette:
Session → `TenantScopeGuard` → Gruppenrechte → Formular-Restriktion, mit
`can_view_responses`. Die Query liest über den `TenantScope`-Delegaten, nicht
über eine eigene Prisma-Instanz.

- **Mit der Sitzung der falschen Organisation: 404**, byte-gleich mit einem
  erfundenen Verweis — kein 403, weil 403 mitteilt, dass es die Ressource gibt.
- **Ohne Sitzung: 401** — nicht 404. Das ist die Antwort, die die Guard-Kette
  ohnehin gibt: der `SessionGuard` weist ab, **bevor** der Verweis gelesen
  wird — das Orakel ist damit geschlossen, und der Nachweis misst es
  (die Antwort auf einen **echten** Verweis ist byte-gleich mit der auf einen
  erfundenen). Eine 404 an dieser Stelle wäre nicht sicherer, aber unehrlich:
  sie sagte einer **abgelaufenen** Sitzung „diese Datei gibt es nicht", obwohl
  es sie gibt und ein erneutes Anmelden genügt.
- `Content-Disposition: attachment` (Nr. 10) und ein **fester** `Content-Type`
  aus der Anlagen-Liste, nie der gespeicherte. Für PDF: `application/pdf`. Die
  Ableitung ist dieselbe wie in (a) — gespeicherter Wert als **Schlüssel** in
  die (hier: Anlagen-)Liste, **kein Treffer → 404**, nicht „dann eben
  `octet-stream`".
- `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`.

**Was von dieser Adresse im CSV-Export steht: nichts** — siehe Nr. 17.

**Die nötige Nachstellung:** Tenant-Filter aus dem Abruf entfernen →
der Test „Anlage einer fremden Organisation" wird rot. Ein Test, der nur den erlaubten
Fall prüft, belegt nichts (Arbeitsregel aus `CONTRIBUTING.md`).

### 12. Der Logo-Verweis wird eine diskriminierte Union, kein Präfix-String

`logo_ref` ist heute ein `z.enum(TENANT_LOGO_REFS)` — mitgelieferte Assets. Das
erweitert sich um „eigene Datei", **ohne** die Auswahl aus den Assets zu
entfernen (eine Organisation ohne eigenes Logo soll nicht in ein Loch fallen). Die Form
dafür ist eine **diskriminierte Union**:

```ts
{ kind: 'asset'; ref: TenantLogoRef } | { kind: 'upload'; ref: FileRef }
```

**Nicht** ein String mit Präfixkonvention (`'upload:xyz'`). Der Unterschied ist
derselbe wie in ADR-0013 Nr. 1: die Konvention ist eine Laufzeitzusage, die
Union eine Aussage des Typsystems. Und sie verhindert konkret, was
`TENANT_LOGO_REFS` verhindern soll: ein `src={logoRef}` durch
String-Verkettung, in dem eine Datenbankspalte entscheidet, was der Browser
eines Besuchers abholt.

**`deliverableBranding()` bleibt die serverseitige Vertrauensgrenze — und die
nötige Eigentümerprüfung kann *nicht* dort stattfinden.** Die Funktion ist rein
und total (sie darf nie werfen, sonst nimmt eine falsche Farbe eine
Ausfüllseite mit), hat keinen Datenbankzugriff und nimmt heute ein
`StoredTenantBranding` mit `logoRef: string | null` entgegen; „gehört diese
Datei dieser Organisation?" kann sie also gar nicht beantworten. Die Eigentümerprüfung
muss deshalb **vor** dem Tor stehen, und zwar so, dass sie strukturell ist: die
Lesequery lädt die Logo-Datei **über die Tenant-Relation**, sodass ein Verweis
auf eine fremde Organisation nichts findet — nicht, weil ein Vergleich danach ihn
verwirft.

**Die Signatur, ausgeschrieben, weil „die Lesequery" vier Ufer sind und nicht
eines:**

```ts
// was in der Spalte stehen kann — unverändert
interface StoredTenantBranding { readonly logoRef: string | null; /* … */ }

// was durch das Tor gekommen ist
type DeliverableLogo =
  | { kind: 'asset';  ref: TenantLogoRef }
  | { kind: 'upload'; ref: FileRef }
  | null;

deliverableBranding(
  stored: StoredTenantBranding,
  /** Der Verweis, den die **Query** als Eigentum dieser Organisation belegt hat. */
  ownedUpload: FileRef | null = null,
): DeliverableBranding          // logoRef: DeliverableLogo
```

Die Regel innerhalb der Funktion bleibt rein und total: `{ kind: 'asset' }`
genau dann, wenn `isTenantLogoRef(stored.logoRef)`; `{ kind: 'upload' }` **nur**,
wenn der gespeicherte Wert als Upload-Verweis liest **und** mit `ownedUpload`
übereinstimmt; sonst `null`. Der Vorgabewert ist der springende Punkt: ein
Aufrufer, der die Datei-Relation **nicht** mitlädt, verliert das Logo
(sichtbar, harmlos, Rückfall auf kein Logo) — er liefert nie einen fremden
Verweis aus. Ein vergessenes Ufer ist damit ein Anzeigefehler und kein
Datenabfluss.

**Und die vier Ufer, namentlich** — jedes lädt die Relation, der Vorgabewert ist
das Netz für ein *fünftes*, das später dazukommt, nicht die Erlaubnis für diese
vier:

1. `apps/api/src/public/public-forms.service.ts` (`tenantOf`) — die
   **sitzungslose** Ausfüllseite. Das tragende Ufer: hier gibt es keine angemeldeten Organisation, gegen den man vergleichen könnte, und genau hier misst die
   nötige Nachstellung.
2. `apps/api/src/auth/session-user.ts` (`toTenantSummary`) — die Sitzungsnutzlast.
3. `apps/api/src/tenant-admin/tenant-branding.service.ts` (`present`) — der
   Reiter *Erscheinungsbild*, der sein eigenes Logo zeigen muss.
4. `apps/api/src/admin/admin.service.ts` (`toRow`) — die Organisation-Übersicht des
   Superadmins, **über Organisationen hinweg**: die Relation wird je Zeile mitgeladen,
   nicht einmal für den Betrachter aufgelöst.

Die Nachstellung (fremden `logo_ref` eintragen) wird so rot, ohne dass
jemand an einen `if` denken muss — und sie wird an **allen vier** Ufern geprüft,
weil ein Tor, das nur an einem hält, ein Tor neben der Tür ist.

*(Seit dem 2026-08-01 trägt der Draht die Union tatsächlich —
`tenantLogoSchema` in `packages/shared/src/branding.ts`, an allen vier Ufern
sowie im Schreib-Schema des Reiters. Die Naht `assetLogoRef()`, die den Draht
bis dahin auf die ausgelieferten Assets verengte, ist damit entfallen. Erst
dadurch misst die Nachstellung, was sie behauptet: vorher waren „eigener
Upload" und „fremder Upload" von außen beide `null` und ununterscheidbar.)*

### 13. Das Beanspruchen beim Absenden — dieselbe Transaktion, fünf Bedingungen

Ein Upload entsteht **vor** der Antwort. Beim Absenden nennt die Einreichung die
Verweise ihrer Dateien; in **derselben Transaktion**, in der die `response`-Zeile
entsteht, wird jede Datei beansprucht — mit einem `UPDATE`, dessen `WHERE`
**fünf** Bedingungen trägt:

1. `response_id IS NULL` — nicht schon beansprucht. Aktualisiert das `UPDATE`
   null Zeilen, wird die Einreichung abgelehnt. Das ist der Mechanismus gegen
   die doppelte Beanspruchung, nicht ein Vorher-Lesen.
2. `tenant_id` **= der Tenant des aufgelösten Formulars**. **Das ist die
   Tenant-Grenze dieser Operation**, und sie steht hier, weil sie in keiner der
   anderen Bedingungen enthalten ist. Der Satz, der zuvor an
   dieser Stelle stand — „weil `form_id` seinen Tenant trägt, ist Bedingung 3
   zugleich die Tenant-Grenze" — war falsch, und zwar auf die Weise, gegen die
   dieser ADR geschrieben ist: er behauptete einen Mechanismus, den das `UPDATE`
   nicht ausführte. `file` hat den zusammengesetzten Fremdschlüssel nicht
   (Nr. 3), also ist eine Zeile mit `form_id` aus Organisation A und `tenant_id` aus
   Organisation B **ausdrückbar** — durch einen Rohschreibzugriff, eine Migration, einen
   künftigen zweiten Schreibpfad. Der Abruf aus Nr. 11(b) liest über den
   `TenantScope`-Delegaten, also über **`tenant_id`**: eine so beanspruchte
   Anlage wäre für die Bearbeiter des **falschen** Organisation lesbar. Zwei
   Bedingungen, weil die eine den Tenant bindet und die andere das Formular, und
   keine die andere impliziert.
3. `form_id` **= das Formular dieser Einreichung**. Damit kann eine Datei, die
   gegen Formular A hochgeladen wurde, nicht an eine Antwort auf Formular B
   gehängt werden — auch nicht innerhalb desselben Organisation, wo Bedingung 2
   nichts sagt.
4. `kind = 'response_attachment'` — ein Logo wird nicht zur Anlage.
5. `created_at > <jetzt> - 24 h` — **jünger als die Purge-Frist aus Nr. 15**,
   gelesen aus **derselben injizierten Uhr** und gegen **dieselbe Konstante**.
   Ohne diese Bedingung ist das Beanspruchen ein Rennen gegen den Purge: der
   wählt „ohne Eigentümer **und** älter als 24 h", und zwischen seiner Auswahl
   und seinem `remove()` liegt ein Zeitraum, in dem dieselbe Zeile beansprucht
   werden kann. Das Ergebnis wäre das schlechteste, das dieser ADR kennt: eine
   **abgesendete Antwort mit einer Anlage ohne Bytes**, ohne Fehler beim
   Absenden, sichtbar erst, wenn ein Bearbeiter Wochen später auf den Link
   klickt. Mit der Bedingung ist es kein Rennen mehr, sondern eine Ordnung: das
   Alter wächst monoton, also kann eine Zeile, die der Purge zum Zeitpunkt `t₀`
   als „älter als 24 h" ausgewählt hat, zu keinem Zeitpunkt `t₁ > t₀` die
   Bedingung „jünger als 24 h" erfüllen. Die Einreichung wird abgelehnt — mit
   der Ablehnung aus Bedingung 1, lesbar als „der Anhang ist abgelaufen, bitte
   erneut hochladen", nicht mit einer stillen Lücke.

**Und der zweite Riegel, weil der erste auf einer Uhr ruht.** Bedingung 5
schließt das Rennen nur, solange Purge und Beanspruchung dieselbe Zeit lesen.
Nr. 15 hält deshalb zusätzlich die Zeile **gesperrt, solange die Bytes
verschwinden**: der Purge wählt seine Kandidaten mit `SELECT … FOR UPDATE`
innerhalb einer Transaktion, entfernt danach die Bytes, löscht dann die Zeilen
und committet erst dann. Ein gleichzeitiges `UPDATE` derselben Zeile wartet auf
diese Sperre und wertet sein `WHERE` **danach** neu aus — auf einer Zeile, die
es nicht mehr gibt, also null aktualisierte Zeilen und eine abgelehnte
Einreichung. Zwei Mechanismen für einen Befund, weil einer davon eine Aussage
über Uhren wäre.

*(Der Modellkommentar in `schema.prisma` trägt die alte Behauptung — „`WHERE
form_id = …` is what keeps a file from crossing into another organisation" — noch. Wer
das Beanspruchen baut, zieht ihn auf diese fünf Bedingungen
nach; ein Kommentar, der eine Sicherheitsgrenze an der falschen Spalte verortet,
ist genau der Fehler in Prosa.)*

Erst hier greifen die Mengen aus Nr. 6 (**10 Dateien, 25 MiB je Antwort**): vor
dem Absenden gibt es keine Antwort, an der man sie messen könnte. Das ist keine
Lücke, sondern die Aufteilung — die Uploadzeit wird von Nr. 7 und Nr. 8
begrenzt, die Antwortzeit von Nr. 6.

**Jede der fünf Bedingungen bekommt ihre Nachstellung**, und ohne sie gilt keine
als gebaut: Bedingung weglassen → der Test, der den unerlaubten Fall versucht,
wird rot. Für Bedingung 2 ist der Aufbau der einzige, der eine Zeile von Hand
braucht — eine `file`-Zeile mit `form_id` aus Organisation A und `tenant_id` aus Organisation B,
geschrieben unter Umgehung der API, genau wie sie ein Rohschreibzugriff
hinterließe — und danach die Prüfung, dass die Einreichung sie **nicht**
beansprucht und der Abruf aus Nr. 11(b) sie in **keinem** der beiden Organisationen
ausliefert. Für Bedingung 5 ist es der Purge-Test aus Nr. 15 mit vorgestellter
Uhr: die 25 Stunden alte Datei wird nicht beansprucht, und die Einreichung
scheitert lesbar, statt eine leere Anlage zu tragen.

**Beim Bearbeiten** (`edit_token`) gilt dasselbe `UPDATE` für neu
hinzugekommene Dateien; entfernte verlieren ihren Eigentümer und fallen dem
Aufräumen aus Nr. 15 zu. *(Ob eine entfernte Anlage sofort oder nach der Frist
verschwindet, entscheidet das Paket, das den Bearbeiten-Pfad anfasst — siehe
„Was dieser ADR nicht entscheidet".)*

### 14. Kein Multipart-Parser: `application/octet-stream`, eine Datei je Anfrage

Der Upload nimmt den **rohen Körper** entgegen, eine Datei je Anfrage, mit dem
Dateinamen im Header (Nr. 10). Kein `multer`, kein `busboy`, kein
`FileInterceptor`.

Drei Gründe, und der dritte ist der, der zählt:

1. **Keine neue Laufzeit-Abhängigkeit im öffentlichen Pfad.** Ein Parser ist
   Code, der auf Bytes von Fremden losgelassen wird; die Spezifikation Nr. 61 hat eine
   Abhängigkeit im öffentlichen Pfad schon einmal aus diesem Grund verworfen.
2. **Der Byte-Zähler und der Abbruch bleiben unsere** (Nr. 6). Bei einem Parser
   wäre die Grenze eine Option, die man richtig setzen muss, und ihr Verhalten
   beim Überschreiten eine Bibliothekseigenschaft.
3. **Es erhält die Eigenschaft, für die `bodyParser: false` in `app-setup.ts`
   gekauft wurde.** Ein HTML-Formular kann nur `application/x-www-form-urlencoded`,
   `multipart/form-data` oder `text/plain` senden. Eine Route, die
   `application/octet-stream` **verlangt** und alles andere mit `415` beantwortet,
   ist für ein fremdes Formular grammatisch unerreichbar — dieselbe Bauform, mit
   der Login gegen Login-CSRF geschützt ist. Eine Multipart-Route wäre es
   nicht.

Die Route verlangt `Content-Type: application/octet-stream` und antwortet sonst
`415`. Das ist auch technisch nötig: `express.json` ist für
`application/json` registriert und *würde* einen so deklarierten Körper
verschlucken (und bei 100 KiB mit `413` abbrechen). Der Client setzt den Header
ausdrücklich — `fetch(url, { body: file })` setzt sonst den Typ der Datei.

Der `CsrfGuard` bleibt global. Der öffentliche Upload ist `@CsrfExempt()` aus
demselben Grund wie die übrigen öffentlichen Routen (er authentifiziert
niemanden); der **Logo**-Upload ist es **nicht** und trägt den CSRF-Header wie
jede andere mutierende Verwaltungsroute.

### 15. Aufräumen: **Anlagen** „ohne Eigentümer **und** älter als 24 Stunden"

Ein `FilePurgeService` nach der Bauform von `MailLogPurgeService` — **eine**
injizierte Uhr, **Startlauf beim Modul-Init und danach ein Intervall**. Der
Startlauf ist nicht Zierrat: ein täglich neu ausgerolltes Deployment, eine
Absturzschleife oder ein Host, der nachts neu startet, käme mit „nur Intervall"
nie zum ersten Lauf. Das ist der Betriebsfehler, und er verlangt eine
Nachstellung.

Das Prädikat ist **dreiteilig**, und jeder Teil ist nötig:

- **`kind = 'response_attachment'`** — der Purge fasst **kein Logo an**, siehe
  den Absatz „Warum der Logo-Arm hier nicht steht" weiter unten, und
- **ohne Eigentümer** (`response_id IS NULL`), und
- **älter als 24 Stunden** (`created_at`, nicht ein Zugriffszeitpunkt).

24 Stunden, weil eine Ausfüllsitzung Minuten dauert und ein Zeitlimit laut
Formular-Einstellungen in derselben Größenordnung liegt; ein Tag ist weit
darüber und hält das Fenster aus Nr. 7 kurz. **Dieselbe Konstante und dieselbe
Uhr** stehen in Bedingung 5 des Beanspruchens (Nr. 13) — zwei Zahlen wären zwei
Meinungen darüber, wann eine Datei abläuft, und die Lücke dazwischen wäre eine
abgesendete Antwort mit einer Anlage ohne Bytes.

**Was diese 24 Stunden *nicht* zusagen: den Dateinamen.** Der Purge nimmt die
Bytes und die Zeile — der **Name** einer entfernten Anlage steht danach weiter
im gerenderten Mailtext im `mail_log`, und der wird nach der Regel für jeden
Antwortinhalt **90 Tage** aufbewahrt. Das ist keine Ausnahme für
Anhänge, sondern dieselbe Frist wie für jede andere Antwort, die je in einer
Mail stand; es steht hier, weil die 24 Stunden oben sonst wie die vollständige
Löschzusage für eine Anlage aussehen. Ein Verweis steht dort nie, nur der Name
(`notification-render.ts` → `formatAnswerCell`), und in eine Logzeile gerät auch
der nicht.

**Eine Transaktion je Datei, nicht je Stapel.** Eine Transaktion über den
ganzen Stapel klingt sicherer — ein scheiterndes `remove()` bricht sie ab, also
sei „nichts committet". Das gilt für die **Zeilen** und nicht für die **Bytes**:
`remove()` ist nicht transaktional und lässt sich nicht zurückrollen. Gemessen
wurde der Fall mit drei abgelaufenen Dateien und einer unlöschbaren in der
Mitte — alle drei Zeilen überlebten, während die Bytes der ersten schon fort
waren, der Rollback gab die Sperre frei, und eine Einreichung beanspruchte diese
Zeile anschließend erfolgreich. **Genau das Ergebnis, gegen das der zweiphasige
Lauf gebaut ist.** Es braucht dafür keine defekte Datei: ein Container-Neustart
oder der Transaktions-Timeout mitten im Stapel erzeugt denselben Zustand.

Je Datei bleibt als Rest nur der Schritt zwischen den beiden Systemen, den keine
Bauform wegnimmt — `remove()` gelungen, `DELETE` nicht —, und der ist innerhalb
einer Transaktion, die Sperre dieser Zeile bereits hält, ein
Verbindungsabbruch und sonst nichts. Dazu gehört, dass **ein Fehler den Lauf
nicht abbricht**: `ORDER BY created_at` stellt die am längsten scheiternde Zeile
in *jeden* ersten Stapel, eine einzige unlöschbare Datei fror den Purge damit
installationsweit dauerhaft ein (gemessen: drei Läufe, nichts gelöscht) — und die
Löschzusage fiel still für die ganze Installation aus. Die Zeile bleibt stehen,
der Lauf geht weiter, der nächste versucht es erneut.

**Der Lauf ist zweiphasig, und das ist der zweite Riegel gegen dasselbe
Rennen.** Ein Lauf wählt seine Kandidaten in einer Transaktion mit
`SELECT … FOR UPDATE` (in Stapeln, damit die Sperre kurz bleibt), entfernt
danach die Bytes, löscht dann die Zeilen und committet. Ein gleichzeitiges
Beanspruchen wartet auf die Sperre und findet die Zeile hinterher nicht mehr —
null aktualisierte Zeilen, abgelehnte Einreichung. Ohne die Sperre lägen
Auswahl und `remove()` auseinander, und in diesem Spalt ist die Datei
beanspruchbar, während ihre Bytes verschwinden. Die Reihenfolge *innerhalb* der
Transaktion ist die aus Nr. 16 (Bytes zuerst, Zeile danach): scheitert
`remove()`, bricht die Transaktion ab, die Zeile bleibt stehen und der nächste
Lauf holt es nach.

**Warum der Logo-Arm hier nicht steht.** „Ein `tenant_logo`, auf das keine
Organisation mehr zeigt" wäre ein Satz ohne Ausdruck. Es gibt keine Spalte, die darauf zeigt: der Verweis lebt in
`tenant.logo_ref` als Union (Nr. 12), also müsste der Purge **installationsweit
rückwärts** über alle Organisationen lesen und jeden Wert parsen. Ein Parse-Fehler, ein
neuer Union-Arm, eine Organisation, deren Zeile gerade geschrieben wird — jedes davon
löscht dann **lebende** Logo, und zwar physisch. Der Purge löscht deshalb
ausschließlich Anlagen. Der Lebenslauf eines Logos gehört dem Logo-Upload
selbst, und ist dort eine Entscheidung zwischen zwei
Formen: eine **Relationsspalte** (`tenant.logo_file_id`, dann ist „zeigt jemand
darauf" ein Fremdschlüssel und keine Textsuche) oder **ausdrückliches Löschen
beim Ersetzen** in derselben Transaktion, in der `logo_ref` geschrieben wird.
Bis dahin ist ein hochgeladenes, nie übernommenes Logo ein **benannter Rest**
— klein, weil diese Route eine Sitzung verlangt und kein Fremder sie erreicht
(Nr. 8), aber nicht null. Er steht unten in „Was dieser ADR nicht entscheidet".

**Und hier ist die Falle, die aufgeschrieben werden muss, weil sie sonst
zuschlägt:** die Zwischenspeicherung bringt **Entwürfe**. Ein Entwurf mit
angehängter Datei ist **nicht** verwaist — aber nach der Definition oben wäre er
es nach einem Tag, und ein Teilnehmer, der nach einer Woche zurückkommt, fände
seinen Nachweis nicht mehr.

**Entschieden: die Anlage lebt so lange wie ihr Entwurf** — 30 Tage, gedeckelt
durch die Frist des Formulars. Die 24-Stunden-Frist bleibt für Dateien **ohne**
beide Eigentümer. Das Prädikat bekommt dafür **einen zweiten Eigentümer-Arm**,
und damit das nicht auf Aufmerksamkeit ruht: **es bringt einen Test mit, der
eine entwurfsgebundene Datei den Purge überleben sieht** (gemessen mit
vorgestellter Uhr). Dazu kommt, dass die Lese-Nutzlast des Entwurfs ihre
Verweise gegen `file` auflöst (`responseDraftSchema.attachments`) und die
Ansicht eine geholte Anlage kenntlich macht, statt sie 30 Tage lang als
angehängt zu zeigen.

**Und das ist mehr als ein Prädikat-Arm, damit es niemand als Einzeiler
einplant:** ein zweiter Eigentümer ist eine **dritte Spalte** (`draft_id`, mit
Fremdschlüssel und `SetNull` wie `response_id`), eine **Änderung der
`CHECK`-Bedingung** aus Nr. 3 (heute sagt sie nichts über `draft_id`; ohne
Erweiterung wäre „Logo mit Entwurf" ausdrückbar), eine Änderung von Nr. 13
(das Beanspruchen räumt beim Absenden den Entwurfs-Eigentümer ab, sonst trägt
die Zeile zwei) und eine zweite Frist, die zur Entwurfsfrist passt statt zu den
24 Stunden. Eine Migration über bestehende Zeilen, kein Prädikat.

Gelöscht wird **physisch** — `remove()` im Storage *und* `delete` auf der Zeile,
kein `deleted_at`. Der Nachweis ist ein `count(*)` ohne Filter plus die Frage an
das Storage-Doppel; ein Test, der das Repository fragt, belegt nur, dass das
Repository filtert.

### 16. Endgültiges Löschen: erst die Bytes, dann die Zeile

Beim endgültigen Löschen aus dem Papierkorb und beim Löschen einer Organisation gilt die Reihenfolge **Bytes zuerst, Zeile danach** — genau
umgekehrt zu Nr. 4, und aus demselben Prinzip: der Abbruch dazwischen soll die
*sichtbare* Hälfte übriglassen. Bleibt die Zeile stehen, weil `remove()` scheiterte,
sieht man es und der nächste Lauf holt es nach. Wäre die Zeile zuerst weg, blieben
Bytes ohne Index zurück — personenbezogene Daten, die Anwendung für gelöscht
erklärt hat und nicht mehr finden kann. Das wäre die DSGVO-Löschzusage
gebrochen, und zwar unbemerkt.

Daraus folgt eine Anforderung an das endgültige Löschen: das Löschen einer Antwort, eines
Formulars oder einer Organisation muss die zugehörigen Dateien **aufzählen und
entfernen**, bevor der Cascade-Löschvorgang ihre Zeilen mitnimmt. Ein
`onDelete: Cascade` auf `file` allein wäre genau der Fall „Zeile weg, Bytes
bleiben". Das ist der Grund, warum diese Löschwege ein
`security`-Review tragen.

### 17. Der CSV-Export trägt den **Dateinamen** — und sonst nichts

Die Vorgabe lässt die Wahl („entweder ein Verweis oder nichts, aber **nie** eine URL, die
ohne Sitzung trägt"). Entschieden ist: **eine Zelle, der Dateiname, kein
Verweis, keine Kennung, keine URL.**

**Warum nicht die URL.** Sie trüge ohne Sitzung nicht (Nr. 11(b)) — aber ein
Export ist genau das Dokument, das per Mail weitergereicht wird und auf
Netzlaufwerken liegt. Eine Adresse darin ist eine Einladung, sie in einen
Browser zu kopieren, und der Tag, an dem eine später gebaute Vorschau-Route die
Sitzungsprüfung anders schneidet, macht aus jedem alten Export ein
Inhaltsverzeichnis. Das ist der Grund, der dafür genannt wird, und er wird hier
nicht abgeschwächt.

**Warum auch nicht der `public_ref` „als bloße Kennung".** Er *sieht* aus wie
eine Kennung und *ist* der Trägerteil der Logo-Adresse (Nr. 11(a)). Ein
undurchsichtiger String in einer Tabellenspalte, aus dem sich mit einem
bekannten Präfix eine Adresse bauen lässt, ist kein Kompromiss zwischen „URL"
und „nichts", sondern eine URL mit einem fehlenden Stück.

**Was das kostet, benannt statt weggeschrieben:** zwei Teilnehmer, die beide
`scan.pdf` hochladen, sind im Export nicht zu unterscheiden, und der Export
trägt heute ohnehin keine Antwort-Kennung (die Spalten sind `submitted_at` plus
die Fragen). Der Weg zur Datei ist die **Antworten-Ansicht** in der Anwendung —
dort steht der Dateiname als Link, hinter der Guard-Kette. Wer den Export
eindeutig machen will, fügt eine **Spalte der Antwort** hinzu; das ist eine
Eigenschaft der Zeile, keine der Datei, und gehört dem Paket, das sie einführt.

Die Zelle läuft durch den Formelschutz ihrer Spalte
(`questionColumns`/`escapeCsvCell`): **ein Dateiname, der mit `=` beginnt, ist
eine Formel**, und `=cmd|'…'!A1.xlsx` ist ein zulässiger Dateiname. Das ist
kein neuer Mechanismus, sondern der vorhandene — und der Nachweis dafür ist ein
Export mit genau so einem Namen, nicht die Sichtprüfung der Spaltendefinition.

### 18. Betrieb: vier Ufer, ein Volume, zwei Grenzen die zueinander passen müssen

**Der Env-Vertrag hat vier Ufer** (`packages/shared/src/env-contract.test.ts`),
und `FILE_STORAGE_DIR` fährt über alle vier: `apiEnvSchema`, `.env.example`
(Name + Zweck, **ohne** Beispielpfad — den lokalen Wert setzt und erzeugt
`dev-setup.sh` über `REQUIRED_DIRECTORIES`, Nr. 2 Grund 4), der
`environment:`-Block des `api`-Dienstes in `docker-compose.yml`, und
`apps/api/test/support/create-test-app.ts`.

**Und hier die Lehre getrennt vom Stand, weil dieser ADR sie im ersten Entwurf
vermischt hat.** *Die Lehre* stammt und gilt unverändert: ein Ufer,
das niemand prüft, altert still, und ein vergessenes zweites oder drittes macht
keine Kompilierung rot — die Installation kommt hoch und läuft auf einer
Vorgabe. *Der Stand* ist seitdem ein anderer, und der Satz „macht gar
nichts rot" ist seitdem schlicht falsch: `env-contract.test.ts` prüft alle vier
Ufer und **in beide Richtungen**, als Gleichheit und nicht als Obermenge. Für
`FILE_STORAGE_DIR` heißt das konkret — nur im Schema: „documents every variable
… in .env.example" wird rot; nur in `.env.example`: die Gleichheit gegen
`apiEnvSchema` + `NOT_READ_BY_THE_API` wird rot; nicht in `docker-compose.yml`:
die Gleichheit des `environment:`-Blocks wird rot; nicht in
`create-test-app.ts`: `pnpm typecheck` **und** die Prüfung der Pflichtvariablen
werden rot. Vier Ufer, vier rote Stellen. Das ist der Grund, warum sich der
Wächter überhaupt als Nachweis bezeichnen lässt — und der Grund, warum ein ADR den
Stand nachliest, statt eine ältere Lehre unverändert
weiterzuschreiben.

**Das Volume.** `docker-compose.yml` bekommt ein benanntes Volume und hängt es
im `api`-Dienst ein. **Und der Punkt, der sonst als 500 beim ersten Upload
auftaucht, während alle Tests grün sind:** das API-Image läuft als `USER node`.
Ein benanntes Volume auf einem Pfad, den es im Image **nicht** gibt, entsteht
Root-eigen — der Prozess kann dann nicht schreiben. Das Dockerfile legt das
Verzeichnis deshalb **vor** `USER node` an und übereignet es
(`mkdir -p … && chown node:node …`), damit Docker die Eigentümerschaft auf das
frische Volume überträgt.

**Die nginx-Grenze.** `apps/web/docker/default.conf.template` setzt heute kein
`client_max_body_size`; nginx' Vorgabe ist **1 MiB**, also würde im
Container-Stack jeder Upload über 1 MiB an der Frontdoor scheitern — mit nginx'
eigener HTML-Seite, nicht mit unserer lesbaren Meldung. Die Location `/api`
bekommt deshalb ein `client_max_body_size` **oberhalb** der größten Dateigrenze
aus Nr. 6 (12m bei 10 MiB), damit die Ablehnung aus der Anwendung kommt und
einen Grund nennt.

Zwei Schreibweisen derselben Zahl sind eine Drift, und sie wird nicht der
Aufmerksamkeit überlassen: **ein Guard-Test liest `client_max_body_size` aus der
Vorlage und prüft, dass er über der größten Dateigrenze liegt** — dieselbe
Bauform, mit der `env-contract.test.ts` die `docker-compose.yml` liest und
`tokens.test.ts` das Stylesheet.

### 19. Der Lebenslauf eines hochgeladenen Logos

Nr. 15 hat diese Entscheidung ausdrücklich offengelassen, mit zwei
Kandidaten: eine **Relationsspalte** (`tenant.logo_file_id`) oder
**ausdrückliches Löschen beim Ersetzen**. Entschieden ist das zweite, in einer
schärferen Form als „beim Ersetzen":

> **Ein `tenant_logo` existiert nur, solange `tenant.logo_ref` es benennt.**

Drei Bauteile tragen die Invariante, und keins davon ist ein Vorsatz:

1. **Der Upload *ist* die Übernahme.** `POST /api/tenant/branding/logo`
   schreibt die Bytes und setzt danach `status = 'stored'` **und**
   `tenant.logo_ref` **in einer Transaktion** (`markLogoStoredAndAdopt`), samt
   `branding_revision`; es gibt keinen Zwischenzustand „hochgeladen, aber noch
   nicht übernommen". Damit ist die Klasse *hochgeladen und nie übernommen* —
   der „benannte Rest", den Nr. 15 stehen ließ — **leer per Bauform** und nicht
   durch Aufräumen.

   ⚠️ **Die eine Transaktion ist tragend.** `status` und `logo_ref` als **zwei**
   Anweisungen lassen dazwischen genau die Zeile liegen, die es nicht geben darf
   — eine fertige `tenant_logo`-Zeile, die niemand benennt. Beide Schreibvorgänge
   prüfen außerdem ihre Trefferzahl: `updateMany` antwortet auf „null
   Zeilen" so bereitwillig wie auf „eine", und ohne diese Prüfung antwortete die
   Route **201 auf einen Upload, der nichts hinterlassen hatte**. Der naheliegende Entwurf (hochladen, beim nächsten
   „Speichern" übernehmen) liest sich wie der Rest des Reiters und erzeugt genau
   diesen Rest: der Purge fasst Logos nicht an, also läge die Datei bis zum
   Ende der Installation auf dem Volume.
2. **Der Rückweg räumt mit auf.** Ein Speichern auf `{ kind: 'asset' }` oder
   `null` lässt die hochgeladene Zeile unbenannt zurück; derselbe Sweep nimmt
   sie. Die Asset-Auswahl bleibt damit vollständig bedienbar — „eine Organisation ohne
   eigenes Logo soll nicht in ein Loch fallen" ist kein Übergangszustand.
3. **Der Sweep ist gescopet und wiederholbar** (`files/logo-sweep.ts`): er läuft
   **nach** dem Schreiben, in einer Organisation, und leitet seine Kandidaten aus der
   Spalte ab (`kind = 'tenant_logo' AND status = 'stored' AND public_ref <>
   tenant.logo_ref`) — nie aus dem, was ein Aufrufer sich gemerkt hat.

   ⚠️ **`status = 'stored'` ist die tragende Bedingung.** Eine Zeile entsteht
   `pending` *vor* ihren Bytes (Nr. 4), und weil der Sweep bei **jedem**
   Branding-Schreiben läuft, genügte ohne diese Bedingung ein zweiter Reiter mit
   einem Farb-Speichern, um einen Upload im Flug zu löschen. Danach legte `put()` die Bytes ohne Zeile an — und weil
   die Naht kein `list()` hat und der Purge kein Logo anfasst, war das
   **unlöschbar**. Gemessen: 201 mit `logoRef: null`, ein Dangling-Verweis in
   `tenant.logo_ref`, null `file`-Zeilen und 520 Bytes auf dem Volume. Reihenfolge **Bytes zuerst, Zeile
   danach** (Nr. 16). Scheitert `remove()`, bleibt die Zeile stehen, der Lauf
   geht weiter, und der **nächste** Branding-Schreibvorgang desselben Organisation
   versucht es erneut. **Ausgeliefert wird sie deshalb trotzdem nicht:** die
   öffentliche Route fragt nicht nur die Zeile, sondern ob `tenant.logo_ref` sie
   noch benennt — sonst lieferte eine Organisation, die ihr Logo zurückgezogen
   hat und ihr Erscheinungsbild nie wieder anfasst, es dauerhaft weiter aus. Der Verweis ist die Wahrheit; das steht in der
   Überschrift dieser Entscheidung und gilt jetzt auch an der Ausgabe.

**Warum nicht die Relationsspalte.** Sie kauft referenzielle Integrität für
*einen* Zeiger und kostet eine zweite Wahrheit über dieselbe Tatsache:
`logo_ref` bliebe bestehen (ein ausgeliefertes Asset ist keine Datei), also
hätte eine Organisation zwei Spalten, die sagen, was ihr Logo ist, und „welche gilt"
wäre eine Regel statt eines Nachschlagens — die Form, die ADR-0013 Nr. 1
ausschließt. Sie beantwortet die Frage auch nicht: `ON DELETE SET NULL` räumt
den Zeiger auf, wenn die Datei geht, nicht die Datei, wenn der Zeiger sich
bewegt — und das ist die Richtung, die etwas liegen lässt.

**Warum das hier geht und im Purge nicht.** Der Unterschied ist der *Umfang*,
nicht das Prädikat. In einer Organisation, in derselben Anfrage, die `logo_ref` gerade
geschrieben hat, ist „welche Zeilen zeigt niemand mehr an" ein Vergleich gegen
einen Wert, der im selben Atemzug gelesen wurde. Installationsweit, im
Intervall, ist es eine Vermutung über jede Organisation gleichzeitig — und dort löscht
ein Parse-Fehler, ein neuer Union-Arm oder eine gerade geschriebene Zeile
**lebende** Logos. Nr. 15 bleibt damit unverändert: der Purge fasst kein
Logo an.

**Was `tenantBrandingWriteSchema` deshalb *nicht* darf.** Der `upload`-Arm im
Schreib-Schema heißt **„behalte mein Logo"**, nie „nimm dieses": das Wählen
eines Uploads ist der Akt der Upload-Route. Der Server lehnt jeden anderen
Upload-Verweis mit `400` ab (`TenantBrandingService.requireOwnLogo`). Das ist
Tiefenstaffelung — das Tor aus Nr. 12 würde einen fremden Verweis ohnehin nicht
ausliefern — und es schließt zusätzlich das Rennen, in dem ein veralteter
Reiter `logo_ref` auf eine Zeile zurückzeigt, deren Bytes der Sweep gerade
genommen hat.

**Die Positivliste bleibt die schmale** (Nr. 5, ausdrücklich geprüft):
**PNG und JPEG, kein PDF.** Die Anlagen-Liste erlaubt PDF, es ist dieselbe
Tabelle — aber ein Logo wird *eingebettet* in eine Seite, die Fremde öffnen,
und „ein Logo ist ein Bild" ist der ganze Unterschied. Ein PDF in einem
`<img>` zeigt nichts; es als Logo anzunehmen hieße, eine Datei anzunehmen,
die eine Stelle, für die sie gedacht ist, nicht bedienen kann. SVG steht
weiterhin auf **keiner** Liste.

**Der Rest, benannt statt weggeschrieben:** eine Organisation, deren `remove()` einmal
scheitert und der sein Erscheinungsbild danach **nie wieder** anfasst, behält
eine unbenannte Zeile und ihre Bytes. Klein (eine je Fehlschlag, je Organisation),
sichtbar (`kind = 'tenant_logo' AND public_ref <> logo_ref` findet sie), und
ohne Zusage, dass jemand sie holt.

### 20. Das Logo wird im Browser zugeschnitten — und das Original nicht aufbewahrt

Wer das Logo hochlädt, soll einen **Ausschnitt wählen** können.
Zwei Dinge daran sind entschieden, und das zweite ist das, was hier
festgehalten werden muss:

> **Der Zuschnitt passiert im Browser, und gespeichert wird ausschließlich das
> Ergebnis. Wer den Ausschnitt ändern will, lädt neu hoch.**

**Warum kein aufbewahrtes Original.** Nr. 19 sagt in einem Satz, was eine
`tenant_logo`-Zeile ist: *„Ein `tenant_logo` existiert nur, solange
`tenant.logo_ref` es benennt."* Diese Invariante trägt drei Bauteile — der
Upload *ist* die Übernahme, der Rückweg räumt mit auf, der Sweep leitet seine
Kandidaten aus der Spalte ab. Ein zusätzlich aufbewahrtes Original ist eine
**zweite Datei mit eigenem Lebenslauf**, und sie fiele durch jedes dieser drei
Bauteile hindurch: `logo_ref` benennt sie nicht (sie ist ja nicht das
ausgelieferte Logo), also nähme der Sweep sie beim nächsten Speichern —
oder, wenn man ihn davon ausnähme, nähme sie *niemand*. Der Purge fasst
Logos nicht an (Nr. 15). Es entstünde damit genau die Klasse, die Nr. 19
**per Bauform leer** gemacht hat: eine fertige Datei, die niemand benennt und
für die es keinen Aufräumweg gibt.

Die Alternative wäre eine zweite Referenzspalte (`tenant.logo_source_ref`) mit
eigener Übernahme, eigenem Sweep-Prädikat und eigener Frist — die
Relationsspalten-Diskussion aus Nr. 19 noch einmal, für einen Komfort, dessen
Ersatz „die Datei noch einmal wählen" ist.

**Der Preis, benannt statt weggeschrieben:** ein Bearbeiter, der den Ausschnitt
nachjustieren will, braucht die Ausgangsdatei noch. Hat er sie nicht mehr, ist
das aktuelle Logo die einzige Quelle, und ein Zuschnitt davon wird kleiner,
nie wieder größer. Für ein Logo, das aus einer Vorlage exportiert wird, ist
das folgenlos; für ein abfotografiertes ist es ein zweites Foto.

**Die Upload-Kette wird nicht angefasst.** Was aus dem Browser kommt, ist eine
gewöhnliche Datei und wird geprüft wie jede andere — Signatur an Offset 0,
Positivliste PNG/JPEG (Nr. 5), 2 MiB (Nr. 6), `X-File-Name` (Nr. 14). **Ein
Zuschnitt im Browser ist kein Vertrauen**: er wählt ein Bild aus, er belegt
nichts über dessen Bytes. Der Server sieht keinen Unterschied zu einem
Upload ohne Dialog und darf keinen sehen.

**Nebenertrag, weil er sonst beim nächsten „Optimieren" verlorengeht:** der Weg
über ein `<canvas>` schreibt die Pixel neu und lässt **jede Metadaten-Struktur
des Originals fallen — EXIF eingeschlossen, und damit die GPS-Koordinaten, die
ein Telefon in ein Foto schreibt.** Der Rest-Absatz weiter unten nennt EXIF als
etwas, das dieser ADR für **Anlagen** *nicht* leistet; für das Logo fällt es
hier ab. Wer diesen Schritt später durch eine Byte-Weitergabe ersetzt, nimmt
das mit weg.

**Was der Browser dabei sonst noch tut, und warum es hierher gehört:** derselbe
Schritt **skaliert**. Ein Telefonfoto ist 3–6 MiB (Annahme A5) und die Grenze
sind 2 MiB — auf einem Weg *ohne* Zuschnitt lehnt der Server also eine Datei
ab, die der Browser hätte in Ordnung bringen können. Deshalb gibt es im
Frontend **keinen zweiten, rohen Pfad** an dem Dialog vorbei; die
Kantenlänge (768 px) und das Ausgabeformat (PNG) sind Frontend-Entscheidungen
und stehen bei ihrem Code (`apps/web/src/views/tenant-admin/crop-geometry.ts`,
`render-crop.ts`), nicht hier.

---

## Der öffentliche Pfad: was die Positivliste kostet

`apps/api/src/public/**` hat in `eslint.config.js` **zwei** Zäune: den
Entschlüsselungs-Zaun (`no-restricted-imports` auf die Dienste, die einen
gesiegelten Wert öffnen oder einen Klartext herausreichen) und die
Prisma-Positivliste, auf der `src/public/**` als **vierter Eintrag** steht. Was
sich hier ändert, vollständig:

**1. Der Entschlüsselungs-Zaun wächst — um Verbote, nicht um Erlaubnisse.**
Neu verboten unter `apps/api/src/public/**`: `fs`, `fs/promises`, `path` und
`child_process` — **jeweils in beiden Schreibweisen**, mit und ohne
`node:`-Präfix, also acht Muster statt vier. `import { readFile } from 'fs'` ist
in Node dasselbe Modul wie `'node:fs'`, ESLint aber vergleicht Zeichenketten:
eine Gruppe, die nur `node:fs` nennt, ist ein Zaun mit einem Tor daneben, und
das Tor sieht im Diff aus wie ein Stilunterschied. Begründung: die ganze Behauptung der
Storage-Naht ist, dass **kein Code außerhalb von ihr weiß, wo eine Datei liegt**.
Der öffentliche Pfad hält deshalb ein Interface, kein Dateisystem —
und Pfadbau im öffentlichen Pfad *ist* die Traversal-Lücke, in Form eines
Imports. `node:crypto` bleibt erlaubt (`edit-token.ts` braucht es). Die Bans
sind aufhebbar, aber nur mit einem Satz im Review, der sagt warum.
Zusätzlich auf die Verbotsliste: die **Adapter**-Datei (`files/local-file-storage`),
damit ein direkter Import des Adapters ein Build-Fehler ist statt etwas, das ein
Reviewer bemerken muss.

**2. Die Prisma-Positivliste wächst um genau einen Eintrag:**
`apps/api/src/files/purge/**`. Der Purge arbeitet **über Tenants hinweg per
Bauart** — kein Request, kein Aufrufer, kein Tenant-Parameter; die Zeilenauswahl
ist `created_at` und die Eigentümerspalte, dieselbe Kategorie wie der
`mail_log`-Purge. Drei Eigenschaften machen den Eintrag vertretbar, und wer eine
davon bricht, braucht eine neue Entscheidung: (a) nur ein Lesen von Schlüsseln,
ein `SELECT … FOR UPDATE` auf dieselben Zeilen (per `$queryRaw`, weil ein
`TenantScope` das nicht ausdrücken kann — wörtlich der Grund, aus dem der
Mail-Worker auf dieser Liste steht) und ein Löschen; **keine Nutzlast wird
gelesen**, kein `answers`, kein `file_name`; (b) nichts aus einem
Request wählt eine Zeile aus; (c) **die Gegenprobe:** `apps/api/src/files/**` —
also der Anlagen-Abruf aus Nr. 11(b) — steht **nicht** auf der Liste und liest
über den `TenantScope`-Delegaten. Deshalb ist es `files/purge/**` und nicht
`files/**`; derselbe Schnitt wie beim achten Eintrag `common/public-url/**`,
der auch nicht `common/**` heißt.

**3. Der Upload-Endpunkt selbst braucht keinen neuen Eintrag.**
`src/public/**` darf Prisma bereits, mit der Begründung des vierten Eintrags:
der Tenant ist nie ein Parameter des Aufrufers, sondern kommt aus dem Formular,
das der Slug auflöst. Für den Upload gilt das unverändert — die `file`-Zeile
erbt `tenant_id` und `form_id` vom aufgelösten Formular.

**4. Und der Satz, der hier stehen muss, weil er falsch war.**
**Ein Argument über den Modulgraphen ist nicht mechanisch.** Früher wurde
dieselbe Liste durch **einen** Import ausgehebelt, der „nur für die Uhr" gedacht
war: `PublicFormsModule` importierte `MailModule`, und das exportierte
`MailSecretsService`, `MailIdentityService` und `MailTransport` gleich mit — der
Kommentar behauptete zu diesem Zeitpunkt noch das Gegenteil. Daraus folgt
**eine Bauvorschrift, nicht ein Vorsatz**: das Modul, das der öffentliche
Pfad für den Speicher importiert, **stellt genau ein Binding bereit und
exportiert genau einen Token** — die Bauform von `MailClockModule`, die als
Antwort auf genau diesen Befund entstanden ist. Der Adapter, der Purge und der
Anlagen-Abruf liegen außerhalb dieses Moduls. Der Zaun aus Punkt 1 fängt die
Ein-Tastendruck-Variante; die Modulform ist das, was die transitive Variante
verhindert, und keine der beiden allein genügt.

**Und weil genau dieser Satz die Stelle ist, an der es schon einmal
gescheitert ist: die Modulform wird *bewacht*, nicht vorgenommen.** Der Befund
damals war nicht, dass jemand die Regel nicht kannte — der Kommentar behauptete
sie sogar — sondern dass **nichts sie prüfte**; bis heute hat `MailClockModule`
keinen Test auf seine `exports`, und ein zweiter Eintrag dort fiele niemandem
auf. Eine Bauvorschrift ohne Test ist derselbe Fehler noch einmal, nur in einem
anderen Modul. `FileStorageModule` hat die Form (ein Binding, ein Token,
Adapter/Purge/Abruf außerhalb) — **und bringt den Test dazu gleich mit**, der aus
dem Modul heraus misst statt aus der Datei:

- ein Testmodul, das **ausschließlich** `FileStorageModule` importiert, löst den
  `FileStorage`-Token auf — und den **Adapter** (`LocalFileStorage`) **nicht**:
  `get()` darauf wirft, auch mit `{ strict: false }`;
- die `exports`-Liste dieses Moduls hat **genau einen** Eintrag, gelesen aus den
  Modul-Metadaten, nicht aus der Quelldatei gelesen und nicht gezählt, wie ein
  Reviewer zählt;
- **derselbe Test für `MailClockModule`**, hier ebenfalls nachgezogen: der Befund, der
  diese Bauform hervorgebracht hat, verdient den Wächter, den sie fordert.

*Nachstellung:* den Adapter zusätzlich exportieren → beide Zusicherungen rot.

---

## Was dieser ADR **nicht** entscheidet — und wer es entscheidet

**Was inzwischen entschieden ist**, und deshalb hier nur noch als Ergebnis
steht:

- **Eine aus einer Korrektur entfernte Anlage verfällt nach 24 Stunden**, also
  schneller als die 30 Tage des Papierkorbs ihrer Antwort. Der Teilnehmer hat
  sie **selbst** entfernt, und für eine Datei, die niemand mehr beansprucht,
  spricht die Datenminimierung für die kürzere Frist. ⚠️ **Unterschieden wird
  nach Absicht, nicht nach Ort:** was am Entwurf *hängt*, lebt 30 Tage; was aus
  ihm *entfernt* wurde, 24 Stunden.
- **Die Anlage einer Antwort im Papierkorb bleibt abrufbar**, bis endgültig
  gelöscht wird — Nr. 11(b) filtert bewusst **nicht** auf `deleted_at`. Der
  benannte Preis: personenbezogene Bytes liegen bis zu 30 Tage länger. Der
  sofortige Weg bleibt *Endgültig löschen* (Nr. 16).
- **Ein Entwurf mit Anhang lebt 30 Tage**, gedeckelt durch die Frist des
  Formulars (Nr. 15).
- **Der Lebenslauf eines hochgeladenen Logos** ist ausdrückliches Löschen beim
  Ersetzen, nicht die Relationsspalte (Nr. 19).
- **Eine anwendungsweite CSP und `X-Content-Type-Options` als globale
  Kopfzeile** stehen: die vollständige Richtlinie für die Seite in
  `apps/web/index.html` **und** im nginx-Template, `nosniff` und
  `frame-ancestors 'none'` an jeder API-Antwort
  (`apps/api/src/common/security-headers.ts`). Nr. 11 bleibt davon unberührt —
  die beiden Dateirouten setzen `nosniff` weiterhin selbst, weil sie es
  unabhängig von der globalen Kopfzeile brauchen. **`Strict-Transport-Security`
  ausdrücklich nicht** — sie gehört an den TLS-Frontdoor.
- **Das Logo wird nicht cachebar**, `no-store` bleibt. Die pauschale Regel ist
  der Grund, warum kein geteilter Cache je eine Antwort dieser API halten darf;
  eine Ausnahmeliste wäre die Stelle, an der die *nächste* Route versehentlich
  landet. Der Preis ist ein Abruf je Seitenaufruf für ein paar hundert Kilobyte
  und damit gemessen klein.
- **Keine Virenprüfung.** Ein Scanner wäre eine Abhängigkeit **im öffentlichen
  Ausfüll-Pfad**; es bleibt bei Positivliste, Signaturprüfung, `nosniff` und der
  Art der Auslieferung.
- **Bildmetadaten werden beim Hochladen entfernt**
  (`apps/api/src/files/image-metadata.ts`): JPEG verliert `APP1` (EXIF und XMP)
  und `APP13`, PNG die Text- und `eXIf`-Chunks, strömend und ohne Umkodieren.

**Was offen bleibt:**

| Offen | Wer entscheidet |
|---|---|
| **Ob und wie eine Anlage in der Oberfläche als Vorschau gezeigt wird.** Sie ist der Weg, auf dem der Download-Schutz umgangen würde — wer sie baut, entscheidet das SVG-Verbot **nicht** neu, sondern die Frage, wie eine Vorschau ohne Origin-Bezug entsteht | eigenes Arbeitspaket, mit `security`-Review |
| **Ein zweiter Storage-Adapter** (S3/objektbasiert). Die Naht macht ihn möglich; verworfen ist er als *Vorgabe*, nicht als Möglichkeit. Ein Adapter, der vorsignierte URLs ausgäbe, bräche Nr. 1 und Nr. 11 und wäre eine eigene Entscheidung | wer ihn braucht, mit ADR |
| **Upload-Fortschritt in der Oberfläche** (`fetch` kennt keinen, `XMLHttpRequest` schon). Nr. 14 ändert daran nichts — Multipart hätte dasselbe Problem | eigenes Frontend-Paket |
| **Deduplizierung, Thumbnails, Konvertierung.** Nichts davon ist entschieden — sie sind Bequemlichkeit, nicht Datenschutz | wer sie braucht |
| **PDF-Metadaten.** Sie bleiben unangetastet; sie zu entfernen hieße, die Struktur des Dokuments zu deuten, also genau die verworfene Inhaltsprüfung | benannter Rest |


---

## Annahmen — als solche markiert

- **A1 — `access(dir, W_OK)` ist ein Rauchtest, keine Garantie.** POSIX-ACLs,
  ein später schreibgeschützt neu eingehängtes Volume oder eine volle Platte
  bestehen ihn und scheitern trotzdem beim Schreiben. Dieser Fall bleibt eine
  500 zur Laufzeit — mit einer Kategorie, **ohne** den Pfad in der Antwort
  (dieselbe Regel wie bei den Mail-Fehlerkategorien, ADR-0013 „Consequences").
- **A2 — Browser ignorieren `Content-Disposition` bei `<img>`-Subresources.**
  Vermutlich richtig, aber nicht unser Mechanismus: deshalb liefert Nr. 11(a)
  `inline` und stützt sich auf die Liste und `nosniff`, statt auf dieses
  Verhalten zu bauen.
- **A3 — die Zähler aus Nr. 7 und Nr. 8 sind prozesslokal.** Gilt für jede
  Grenze dieser Anwendung; ein horizontal skaliertes Deployment vervielfacht
  sie alle.
- **A4 — Magic Bytes belegen den Anfang, nicht den Rest.** Ein PNG, dessen Ende
  ein ZIP-Archiv ist, wird angenommen. Das ist bewusst getragen: die Alternative
  wäre die verworfene Inhaltsprüfung, und der Schutz kommt aus der
  Auslieferungsart (Nr. 11), nicht aus der Vollständigkeit der Prüfung.
- **A5 — die Zahlen aus Nr. 6 sind geschätzt**, nicht an echtem Verkehr
  gemessen. Erste Gelegenheit zur Nachprüfung: ein Testlauf mit echtem Verkehr.
- **A6 — `express.json` fasst einen `application/octet-stream`-Körper nicht an.**
  Das ist die Vorgabe von `body-parser` (`type: 'application/json'`), und
  `app-setup.ts` verlässt sich an einer anderen Stelle bereits darauf. Es wird
  hier trotzdem als Annahme geführt, weil Nr. 14 daran hängt — **ein Test misst
  es**: ein Upload-Körper von mehr als `JSON_BODY_LIMIT_BYTES` kommt vollständig
  am Zähler an, statt mit `413` aus dem Parser zu fallen.
- **A7 — `%PDF-` an Offset 0 lehnt gültige PDFs ab**, wenn ihnen Leerraum, ein
  Zeilenumbruch oder ein BOM vorangeht; Scanner erzeugen so etwas. Bewusst
  getragen (Nr. 5) und in einem Testlauf gemessen, nicht geglaubt: der Durchlauf lädt ein
  echtes Scanner-PDF hoch. Fällt es durch, ist die Antwort **nicht** „Header
  irgendwo in 1024 Bytes suchen", sondern eine eigene Entscheidung — etwa das
  Überlesen einer festen, kleinen Zahl von Whitespace-Bytes, was etwas ganz
  anderes ist als ein Suchfenster.

---

## Consequences

- **Die Anwendung hat zum ersten Mal Zustand außerhalb der Datenbank.** Ein
  Backup, das nur `pg_dump` sichert, sichert die Anlagen nicht mehr — und ein
  Restore ergäbe Zeilen, deren Bytes fehlen. Das gehört in die
  Backup-Restore-Probe und wird hier benannt, damit es dort nicht neu
  gefunden werden muss.
- **Eine bestehende Installation startet nach diesem Update nicht**, bis
  `FILE_STORAGE_DIR` gesetzt ist (Nr. 2). Bewusst; der Weg ist
  `scripts/dev-setup.sh`.
- **Der öffentliche Pfad nimmt jetzt Bytes an.** Das ist die größte Änderung
  seiner Angriffsfläche. Alle Pakete daran tragen ein `security`-Review, und
  das ist nach diesem ADR nicht weniger nötig, sondern gezielter: dieses
  Dokument sagt, wo hingeschaut wird.
- **Die Tenant-Grenze von `file` ruht auf einer Query-Bedingung, nicht auf einem
  Fremdschlüssel** (Nr. 3). Das ist schwächer als bei `response`, es ist
  begründet, und es macht den Test zu **Nr. 13 Bedingung 2** — `tenant_id` im
  `WHERE` des Beanspruchens — zum tragenden Nachweis, nicht zu einem
  von vielen. ⚠️ Die Bedingung „kommt" **nicht** aus `form_id` mit; sie steht
  ausdrücklich im `UPDATE`, und der Test misst genau das.
- **Der Verallgemeinerung des Rate-Limit-Trackers** (Nr. 8) fasst
  sicherheitsrelevanten Code an anderer Stelle an. Dessen Tests sind Sicherheitsnachweise; sie bleiben grün, und
  „ich habe den Test angepasst" ist dort die falsche Richtung — die Lehre aus
  ADR-0013 Nr. 7, wo ein Cache beinahe einen Sicherheitsnachweis umgeschrieben
  hätte.
- **Das Logo wird bei jedem Seitenaufruf neu geladen** (Nr. 11(a),
  `no-store`). Für eine öffentliche Ausfüllseite auf einer Mobilverbindung ist
  das ein spürbarer, bewusst getragener Preis.

---

## Alternatives considered

1. **`503` am Upload statt Startverweigerung.** Vertretbar und
   ausdrücklich als Option genannt. Verworfen aus den vier Gründen in Nr. 2, vor
   allem dem dritten: `503` ist nicht *eine* Entscheidung, sondern eine
   Bedingung, die sich durch den öffentlichen Pfad ausbreitet.
2. **Multipart (`multer`/`busboy`) statt rohem Körper.** Der Standardweg, und
   für einen Browser bequemer. Verworfen (Nr. 14): eine neue Parser-Abhängigkeit
   an der einen Stelle, die jeder im Internet erreicht, und der Verlust der
   Eigenschaft, dass ein fremdes HTML-Formular die Route nicht ansprechen kann.
   **Der Preis ist real:** ein `<form enctype="multipart/form-data">` als
   Rückfall ohne JavaScript ist damit unmöglich. Die Ausfüllseite ist bereits
   eine React-Anwendung, die ihre Einreichung als JSON schickt — der Rückfall
   existiert also ohnehin nicht.
3. **Zwei Tabellen (`response_file`, `tenant_logo_file`) statt einer mit
   `kind`.** Wäre stärker: der öffentliche Logo-Abruf könnte eine Anlage dann
   nicht einmal *benennen*, und `response_file.(form_id, tenant_id)` wäre als
   zusammengesetzter Fremdschlüssel möglich (Nr. 3). Verworfen, weil Nr. 3 „ein
   `file`-Modell" sagt und eine Abweichung davon eine Festlegung wäre, nicht
   eine des Bauenden. Die `CHECK`-Bedingung und die
   getrennten Repositorien holen den größeren Teil des Ertrags; **was fehlt,
   ist der Fremdschlüssel, und das steht in Nr. 3 statt hier**.
4. **Dateien als `bytea` in der Datenbank.** Erspart Volume, Backup-Frage und
   Naht. Ausgeschlossen durch Nr. 3 — und zu Recht: ein 10-MiB-Blob durch Prisma zu
   streamen, geht nicht, also läge jede Datei vollständig im Speicher des
   Prozesses, und die Grenze aus Nr. 6 würde damit zur Speichergrenze mal
   Nebenläufigkeit.
5. **Die Datei ganz in den Speicher lesen, dann prüfen, dann schreiben.** Macht
   die Prüfreihenfolge trivial. Verworfen aus demselben Grund wie 4: nichts im
   öffentlichen Pfad begrenzt die Nebenläufigkeit, also wäre die Grenze je Datei
   in Wahrheit „Grenze × gleichzeitige Uploads" an Arbeitsspeicher.
6. **Eine Byte-Quote je Formular oder je Organisation.** Der naheliegende Schutz des
   Volumes. Ausgeschlossen: es ist wörtlich der Hebel — ein Dritter
   füllte sie mit gültigen Uploads und schaltete damit die Anmeldung einer Organisation ab. Ersetzt durch die Zähler je Adresse (Nr. 7), mit dem verteilten
   Fall als benanntem Restrisiko.
7. **Signierte, ablaufende Download-URLs** statt der Guard-Kette für Anlagen.
   Bequem für Mail-Anhänge und CDNs. Verworfen aus dem Grund, den
   `public/edit-token.ts` bereits für das Bearbeiten-Token aufschreibt: eine
   Signatur ist einzeln nicht widerrufbar, nur durch Rotation ihres Subkeys —
   und die trifft jeden Link der Installation auf einmal. Bei personenbezogenen
   Anlagen ist „wir können das nicht zurücknehmen" der falsche Satz.
8. **Den Dateinamen verwerfen und aus `public_ref` + Endung einen erzeugen.**
   Am konservativsten. Verworfen, weil Nr. 10 den Dateinamen als Anzeige verlangt und
   „Nachweis_Mueller.pdf" für einen Bearbeiter der Unterschied zwischen einer
   Liste und einer Rätselaufgabe ist. Abgesichert stattdessen durch Nr. 10 — an
   zwei Stellen, weil eine geraten wäre.

**Nebenwirkung, die benannt gehört: die Positivliste des *Clients* ist auf
diesem Weg aufgehoben.** Was ein `<img>` dekodiert — SVG, GIF, WebP, AVIF, wenn
jemand im Dateidialog „alle Dateien" wählt — wird durch den Canvas zu PNG
umkodiert, und der Server nimmt das Ergebnis an, weil es *ist*, was er verlangt.
Serverseitig ist daran nichts locker: geprüft wird weiterhin die Signatur der
Bytes, die ankommen, und die sind ein rasterisiertes PNG ohne Skript, ohne
externe Verweise und ohne die Angriffsfläche, wegen der SVG auf keiner Liste
steht. Der Satz „SVG wird nicht angenommen" im Hinweistext beschreibt
damit aber nicht den ganzen Weg, sondern den *direkten* — hier festgehalten
statt stillschweigend hingenommen. Wer das
nicht will, prüft den Typ **vor** dem Dialog im Client; das wäre eine zweite
Wahrheit über erlaubte Typen und ist deshalb nicht geschehen.

**Und noch eine, die dem Bearbeiter nützt:** derselbe Schritt **skaliert**. Ein
Telefonfoto von 3–6 MiB (Annahme A5) liefe ohne ihn an der 2-MiB-Grenze auf,
obwohl der Browser es richten kann. Das ist der Grund, aus dem der
Zuschnitt der Regelweg ist und nicht ein zweiter Knopf.
