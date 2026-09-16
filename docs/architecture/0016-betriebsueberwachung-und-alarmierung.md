# 16. Betriebsüberwachung — von innen ohne Fremdsystem, von außen durch einen fremden Beobachter

- **Status:** accepted
- **Date:** 2026-08-11

## Context

Bislang wurde eine Anwendung gebaut, die **niemand beobachtet**. Das war richtig,
solange sie nicht lief; jetzt
läuft sie, und drei Zusagen dieses Projekts hängen ab jetzt daran, dass jemand
merkt, wenn sie brechen:

1. **Post geht raus** (ADR-0004) — die Warteschlange ist eine Tabelle,
   und eine Zeile, die niemand abholt, bleibt still liegen.
2. **Fristen werden eingehalten** (DSGVO) — Papierkorb 30 Tage,
   `mail_log` 90, KI-Freitext 30, unbeanspruchte Anlage 24 Stunden. Durchgesetzt
   wird das von **fünf** Hintergrundläufen.
3. **Die Anwendung ist erreichbar** — für Ausfüllende ohne Konto, oft mit einer
   Frist im Nacken (Anmeldeschluss einer Veranstaltung).

Was heute an Beobachtung existiert, ist **eine Route, die Unwahrheit sagt**:
`GET /api/health` liest ausschließlich die Umgebung (Status, Version, Uptime).
Die Healthcheck des `api`-Containers fragt genau sie. Eine Installation mit
toter Datenbank meldet damit `healthy`, `docker compose ps` bestätigt es, und
der nginx-Frontdoor startet über `depends_on: … condition: service_healthy` vor
eine API, die keine einzige Antwort speichern kann.

Dazu kommt eine Lücke, die keine Route schließt: **ein Lauf, der gar nicht
startet, hinterlässt nichts.** Ein gescheiterter Purge schreibt eine
`logger.error`-Zeile in einen Container-Stream, den niemand aufbewahrt; ein
Purge, der nie startet — der Fall, in dem eine täglich neu
ausgerollte Installation nie gelöscht hätte —, schreibt **gar nichts**. Die
DSGVO-Zusage wäre gebrochen, und die Installation sähe dabei gesund aus.

## Decision

**Überwacht wird auf zwei Wegen gleichzeitig:** von **innen** ohne Fremdsystem und von **außen** durch einen Beobachter, der
nicht Teil dieser Installation ist.

Der Grund ist nicht Gründlichkeit, sondern dass **jeder Weg allein einen blinden
Fleck hat, und zwar keinen kleinen**:

| | sieht | sieht **nicht** |
|---|---|---|
| **innen** | Warteschlange, Läufe, Ablage, Kontingente — und **„dieser Lauf hat heute Nacht nicht gearbeitet"** | den Totalausfall. Und: der Alarmweg ist derselbe SMTP-Weg, dessen Ausfall er melden soll |
| **außen** | „antwortet nicht", TLS abgelaufen, Antwortzeit — mit **eigener Ausfalldomäne** | alles Innere. Ein Beobachter kann nicht wissen, dass ein Purge ausgefallen ist, solange jede Seite antwortet |

### 1. Bereitschaft und Lebendigkeit sind zwei Routen

- `GET /api/health` bleibt **Lebendigkeit**: Prozess, Version, Uptime.
  Unverändert, unauthentifiziert, ohne Auskunft über den Zustand der
  Installation.
- `GET /api/health/ready` kommt dazu: **Bereitschaft**, ein billiger
  Datenbankkontakt mit **eigener kurzer Frist**, Antwort **200** oder **503**,
  ebenfalls ohne Details.

Die Compose-Healthcheck der `api` fragt künftig die **Bereitschaft** — sie ist
die Bedingung, unter der Frontdoor startet.

⚠️ **Warum trotzdem zwei Routen, obwohl Compose heute nur eine Frage stellt.**
`restart: unless-stopped` reagiert auf das **Beenden** des Containers, nicht auf
den Health-Status; Neustarts wegen Gesundheit kennen Swarm und Kubernetes, nicht
der Stack, der hier läuft. Die Trennung ist also **Vorsorge, nicht Reparatur** —
und sie kostet heute eine Route. Sie wird jetzt gezogen, weil der Tag, an dem
jemand diesen Stack unter einen Aufseher stellt, der aus „ungesund" einen
Neustart ableitet, der schlechteste Zeitpunkt dafür wäre: dann startete ein
gesunder Prozess neu, weil die *Datenbank* fehlt, und würfe warmen Zustand weg,
ohne irgendetwas zu reparieren.

Dazu kommt, was **eine** Route grundsätzlich nicht ausdrücken kann: den
Unterschied zwischen *„Prozess weg"* und *„Prozess da, Datenbank weg"*. Genau
den brauchen der äußere Beobachter und der Betreiber, um zu wissen, wo sie
suchen.

### 2. Jeder Hintergrundlauf führt Buch (`job_run`)

Eine Tabelle, eine Zeile je Lauf, **bei Erfolg und bei Fehlschlag**: Art, Start,
Ende, Ergebnis, behandelte Elemente, **Fehlerklasse — nie die Meldung**
.

Daraus folgt die Antwort auf den Fall, den keine Route sieht: „letzter
erfolgreicher Lauf vor *n* Stunden" ist eine Abfrage, und ein Lauf, der nie
startet, lässt diese Zahl wachsen.

⚠️ **Die Zeile zählt, sie benennt nicht.** Keine Empfängeradresse, kein
Formularname, keine Organisation-Kennung. Eine Buchführung über Aufräumläufe, die
festhält, *wessen* Daten gelöscht wurden, wäre das Gegenteil dessen, wofür die
Läufe da sind.

### 3. Ein Betriebsstatus für den Superadmin

Eine Route und eine Ansicht mit fünf Zahlengruppen: **Warteschlange**
(`queued`, Alter der ältesten Zeile, `failed`) · **Läufe** (aus `job_run`) ·
**Ablage** (Bytes und Dateien des Upload-Verzeichnisses) · **KI** (Aufrufe,
Fehlerquote, Kontingentstand) · **Fassung** (die Version dieses Prozesses).

> Unter den fünf Gruppen steht zusätzlich eine Tabelle **„KI-Verbrauch je
> Modell"** — Kennung, aufgelöste Fassung, Aufrufe, Token ein und aus. Sie ist
> keine sechste Zahlengruppe und hat **keine Ampel**: es gibt keine Schwelle,
> über der ein Modell „zu viel" verbraucht, und eine Ampel ohne Schwelle wäre
> Farbe ohne Aussage. Sie ist eine *Auskunft*, kein Wächter.
>
> Zwei Spalten für das Modell, weil die Anwendung unter einem **wandernden
> Alias** ruft und der Anbieter genau diesen zurückmeldet.
> Zwei Zeilen mit derselben Kennung und verschiedener Fassung heißen: der Alias
> ist mitten im Monat weitergezogen — ohne die zweite Spalte sähe das aus wie
> eine Zeile.
>
> ⚠️ **Mengen, keine Kosten.** Keine der beiden Anbieter-APIs liefert Preise;
> eine handgepflegte Preistabelle veraltete still. Die Rechnung kommt vom
> Anbieter, und diese Tabelle sagt, wie sie zustande kam.

Sie ist **installationsweit** und damit tenant-frei — sie braucht denselben
begründeten Eintrag auf der `PrismaService`-Allowlist wie der Mail-Worker und
einen `SuperadminGuard`. Die Zahlen sind Summen; **Organisation-Namen stehen nicht
darin**.

### 4. Alarm an eine Adresse, Schwellen fest

Alarmiert wird per Mail an eine Betreiberadresse aus den systemweiten
Einstellungen, über denselben SMTP-Weg, den die Anwendung ohnehin hat.

Schwellen:

| Kennzahl | Schwelle | Warum diese Zahl |
|---|---|---|
| Alter der ältesten `queued`-Zeile | **30 min** | der Worker läuft im Minutentakt; 30 Minuten sind kein Rückstau mehr, sondern ein Stillstand |
| `failed` **in den letzten 6 h** | **> 5** | eine einzelne unzustellbare Adresse ist normal, sechs in sechs Stunden sind ein Mailserver-Problem |
| letzter **erfolgreicher** Lauf | **> 26 h** | die einzige nicht frei gewählte Zahl: die Läufe gehen im 24-Stunden-Takt, 26 lässt einem verspäteten Lauf Luft, ohne einen ausgefallenen zu verschlucken |
| Füllstand der Upload-Ablage | **> 85 %** | lässt bei den Grenzen aus ADR-0014 Zeit zum Handeln, bevor Uploads 500 antworten |
| KI-Fehlerquote im Zeitraum | **> 25 %** | läuft leer, solange die Funktion aus ist |

> ⚠️ **Gezählt wird ein Fenster, nicht der Bestand.** „`failed` seit dem
> letzten Alarm" wäre die naheliegende Formulierung und die falsche Bauform: der
> Bestand der Tabelle fällt erst, wenn die 90-Tage-Löschfrist die Zeilen
> abräumt, also alarmierte eine Häufung von gestern noch ein Vierteljahr lang
> alle sechs Stunden weiter. Das Fenster ist genauso lang wie die
> Wiederholungssperre — kürzer ließe Fehlschläge zwischen zwei Alarmen unter den
> Tisch fallen, länger meldete dieselben zweimal.

Zwei Eigenschaften sind wichtiger als die Zahlen selbst:

- **Der Alarm wird *direkt* versendet, nicht eingereiht.** Ein Alarm über den
  Rückstand der Mail-Warteschlange, der selbst in dieser Warteschlange landet,
  steht hinter dem Rückstand, den er meldet.
- **Er wiederholt sich nicht endlos.** Eine Wiederholungssperre je Kennzahl;
  ohne sie ist der erste Alarm der letzte, den jemand liest.

### 5. Der äußere Beobachter wird eingerichtet, nicht gebaut

Aus diesem Repository kommt nur, **was er fragen kann**: die Bereitschaftsroute,
ohne Anmeldung durch den Frontdoor erreichbar, billig (**ein** Datenbankkontakt,
keine Zählung über Tabellen — ein Beobachter fragt alle 60 Sekunden, das sind
1 440 Abrufe am Tag) und ohne Auskunft über die Installation.

Der Dienst selbst (Uptime Kuma, ein bezahlter Ping-Dienst, was auch immer) ist
**Betreibersache** und steht im Betriebshandbuch, nicht im Code.

⚠️ **Er meldet auf einem *anderen* Kanal als der innere Alarm** — Telegram,
Push, oder eine Mailadresse bei einem anderen Anbieter. Meldete er an dieselbe
Adresse, nähme ein Mailausfall genau den Weg mit, der ihn melden soll, und die
Arbeitsteilung dieses ADR fiele auf einen einzigen Kanal zusammen.

### 6. Protokolle sind maschinenlesbar und tragen keine Personen

In `production` JSON-Zeilen mit Zeitstempel, Stufe, Kontext und **Anfrage-ID**;
die ID reist im Antwort-Header, damit ein Betreiber eine Beschwerde einer Zeile
zuordnen kann, **ohne den Inhalt zu protokollieren**.

Was nie ins Protokoll gehört: Antwortwerte, E-Mail-Adressen, Zugangswörter,
Schlüssel. Das ist keine Stilfrage — druckte `MISTRAL_DEBUG` den
API-Schlüssel im Klartext und `ANTHROPIC_LOG=debug` den Freitext des
Bearbeiters. Beide fand ein Review, kein Test; hier bekommen sie einen.

### 4a. Eine Kennzahl lässt sich quittieren (Fortschreibung 2026-09-16)

Die Wiederholungssperre aus Punkt 4 kappt den Lärm auf **vier Mails am Tag je
Kennzahl** — und zwar so lange, bis die Ursache weg ist. Für den Fall, für den
sie gebaut ist (ein unbemerkter Ausfall), ist das richtig. Für den häufigeren
Fall ist es genau die Alarmmüdigkeit, gegen die sie steht: der Betreiber
**kennt** die Ursache, die Behebung ist terminiert („die Platte wird Freitag
vergrößert"), und bis dahin kommen zwölf Mails, die nichts Neues sagen. Wer sie
wegklickt, klickt irgendwann auch die weg, die etwas sagt.

Deshalb kann ein Superadmin eine Kennzahl in *Systemverwaltung → Überwachung*
**quittieren**. Vier Eigenschaften, und jede einzelne ist eine Entscheidung
gegen die bequemere Bauform:

1. **Quittiert heißt nicht behoben.** Die Ampel bleibt rot, die Zahl bleibt
   über der Schwelle, und neben der Karte steht „quittiert". Ein Knopf, der die
   Ansicht grün macht, wäre ein Knopf, der die Überwachung belügt.
2. **Mit Frist, und „bis auf Weiteres" ist nur eine der Wahlmöglichkeiten** —
   24 Stunden, 7 Tage, 30 Tage oder ohne Ende. Eine vergessene befristete
   Quittierung verfällt von selbst; eine unbefristete bleibt, bis jemand sie
   zurücknimmt oder die Kennzahl sich erholt. Die Frist rechnet der **Server**
   aus der gewählten Dauer aus; der Aufrufer schickt die Wahl, nie einen
   Endzeitpunkt.
3. ⚠️ **Die Erholung beendet die Quittierung.** Fällt die Kennzahl wieder unter
   ihre Schwelle, wird die Quittierung gelöscht — ein späterer Ausbruch ist ein
   **neuer Vorfall** und meldet sich. Ohne das wäre „bis auf Weiteres" ein
   dauerhaft blinder Fleck, und genau der ist die Lücke, gegen die dieser ADR
   überhaupt geschrieben ist. Was die Erholung **nicht** zurücksetzt, ist die
   Wiederholungssperre: eine um ihre Schwelle pendelnde Kennzahl meldete sonst
   alle fünf Minuten.
4. **Wer und warum steht dabei.** Person und eine kurze Begründung (200
   Zeichen) hängen an der Quittierung, weil eine Installation seit ADR-0029
   zwei Superadmins haben kann — und der zweite sonst nur sähe, *dass* jemand
   den Alarm stillgelegt hat.

**Keine Eskalation bei Verschlechterung.** 86 % und 95 % Füllstand sind
dieselbe Kennzahl, und eine zweite, höhere Schwelle je Zahl wäre ein zweiter
Satz Zahlen, den niemand pflegt. Wer Ruhe bestellt hat, bekommt Ruhe.

⚠️ **Eine Quittierung gilt der Kennzahl, nicht der Ursache.** `job_stale`
deckt alle Hintergrundläufe ab: wer ihn wegen `retention_purge` quittiert,
hört auch von einem später ausfallenden `file_purge` nichts mehr. Das ist der
Preis von fünf Kennzahlen statt einer je Lauf — und der Grund, warum die
befristeten Wahlmöglichkeiten überhaupt angeboten werden und nicht nur ein
Schalter.

**Kein Ein-Klick-Link in der Alarmmail.** Er wäre um drei Uhr nachts bequem und
ist die einzige Stelle, an der die Überwachung ohne Anmeldung stillzulegen
wäre — ein weitergeleitetes Postfach genügte. Die Mail verweist stattdessen auf
die Ansicht; der Weg dorthin ist der Anmeldeweg, den es ohnehin gibt.

## Was dieser ADR **nicht** entscheidet

- **Wer nachts aufsteht.** Der Empfänger steht in den systemweiten
  Einstellungen; wer ihn liest und wann er reagiert, ist eine Betreiberfrage.
- **Welchen Dienst der äußere Beobachter benutzt.** Siehe 5.
- **Eine zentrale Protokoll-Sammlung** (ELK, Loki) — eine bewusste Abgrenzung,
  keine offene Frage. Aus der Anwendung kommt, was ein Sammler braucht:
  maschinenlesbare Zeilen (Punkt 6), eine `job_run`-Zeile je Lauf und
  `GET /api/admin/ops`. **Womit** der Betreiber sie einsammelt und wie lange er
  sie hält, ist seine Entscheidung und seine allein; die Anwendung ändert sich
  dafür nicht.
- **Hochverfügbarkeit.** Bei ~50 Organisationen und ~20 gleichzeitigen
  Ausfüllenden nicht begründbar.

## Alternatives considered

### Prometheus + Grafana im Compose-Stack

`/api/metrics`, zwei bis drei weitere Container mit eigenen Volumes,
Scrape-Konfiguration, Dashboards und Alertmanager-Regeln im Repo.

**Erwogen und verworfen**, nicht weil es schlecht wäre: es kann alles, was
Punkt 1–4 können, **und zusätzlich Verlauf** — „seit wann steigt der Rückstand"
statt „er ist hoch".

Dagegen sprach die Bilanz an dieser Größe: drei Dienste, die aktualisiert,
abgesichert und selbst überwacht werden wollen · Grafana als zweite
Anmeldefläche im Netz · Alarmregeln als **zweite Wahrheit** neben den Schwellen
im Code · und Metrik-Label, die keine Organisation- oder Formularnamen tragen dürfen,
weil ein Personenbezug in einer Zeitreihe schlechter zu löschen ist als in einer
Tabelle. Den **Totalausfall** sieht es obendrein nicht verlässlich, weil es
meist auf demselben Host stirbt — es ersetzt den äußeren Beobachter also nicht.

**Nachholbar**, und das ist der Grund, warum die Ablehnung billig ist: der
Betriebsstatus aus Punkt 3 führt genau die Zahlen, die eine `/api/metrics`
ausgäbe. Wer sie später exportieren will, schreibt einen zweiten Leser auf
dieselbe Quelle.

### Nur ein äußerer Beobachter, nichts im Inneren

Billiger und ehrlich für die Frage „läuft es?". Beantwortet aber die drei
Zusagen aus dem Context nicht: ein ausgefallener Purge, eine volle Warteschlange
und eine volle Platte sehen von außen **wie eine gesunde Anwendung aus** —
bis Wochen später jemand merkt, dass nichts gelöscht wurde.

### `/api/health` einen Datenbankkontakt geben, ohne zweite Route

Der kleinste Eingriff, und er verwechselt zwei Fragen dauerhaft. Siehe
Decision 1.

## Consequences

- **Eine neue öffentliche Fläche.** `GET /api/health/ready` gehört auf die
  Positivliste der ungeschützten Routen und ist die erste von ihnen, deren
  Antwort vom Zustand der Datenbank abhängt. „200 oder 503" ist bereits eine
  Auskunft; mehr darf sie nicht geben.
- **Eine neue Tabelle** (`job_run`) mit einer Migration und fünf Schreibern.
- **Ein weiterer installationsweiter Dienst** auf der `PrismaService`-Allowlist,
  mit Begründung.
- **Der Betreiber bekommt eine Pflicht**, die er vorher nicht hatte: den äußeren
  Beobachter einzurichten und **einen Probealarm zu quittieren**. Ein Meldeweg,
  der nie ausgelöst hat, ist eine Vermutung.

## References

- [ADR-0004](0004-mail-db-queue.md) (Warteschlange in der Datenbank) ·
  [ADR-0011](0011-systemweite-einstellungen.md) (wo der Empfänger steht) ·
  [ADR-0013](0013-versandidentitaet-je-organisation.md) (über welchen Weg der Alarm geht)
