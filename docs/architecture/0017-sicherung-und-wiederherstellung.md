# 17. Sicherung und Wiederherstellung — ein Skript im Repo, die Probe in der CI, drei Gegenstände

- **Status:** accepted
- **Date:** 2026-08-11

## Context

Bislang hat diese Anwendung **keine Sicherung**. Kein Skript, kein Job, keine
Anleitung — weder für die Datenbank noch für das Volume `api-files`, in dem
seit ADR-0014 die hochgeladenen Anlagen liegen.

Das war vertretbar, solange nichts lief. Jetzt
läuft es, und der Bestand ist nicht ersetzbar: Anmeldungen zu Veranstaltungen,
Bestandsmeldungen, Sterbefallmeldungen — Dinge, die eine Organisation einmal einreicht
und nicht noch einmal einreicht, weil ein Datenträger ausgefallen ist.

Drei Eigenschaften dieses Systems machen die Sicherung schwieriger, als sie
klingt:

1. **Der Bestand liegt an zwei Orten.** Zeilen in PostgreSQL, Bytes im Volume.
   Ein `pg_dump` allein stellt Antworten wieder her, deren Anlagen fehlen — die
   Antwort trägt dann einen Verweis auf eine Datei, die es nicht mehr gibt, und
   die Anwendung meldet an genau der Stelle einen Fehler, an der ein Teilnehmer
   etwas hochgeladen hatte.
2. **Ein Teil des Bestands ist verschlüsselt, und der Schlüssel liegt
   woanders.** Zugangswörter geschützter Formulare, SMTP-Passwörter und
   OIDC-Client-Secrets sind mit `SECRET_BOX_KEY` versiegelt. Der steht in der
   Umgebung, nicht in der Datenbank.
3. **Die Sicherung selbst ist personenbezogen.** Sie trägt Antworten,
   Adressen, Anlagen und Passwort-Hashes. Eine unverschlüsselte Kopie auf einem
   fremden Speicher wäre die größte Datenmenge, die diese Anwendung je an einem
   Stück herausgibt.

## Decision

### 1. Ein Skript im Repository, die Probe in der CI

`scripts/backup.sh` erzeugt **einen** Vorgang mit **einem** Zeitstempel, der
beide Hälften enthält, und `scripts/restore.sh` spielt ihn zurück. Die
**Wiederherstellungsprobe** läuft als eigener CI-Job, weil es dort einen
Docker-Daemon gibt.

**Hoster-Snapshots wurden erwogen und sind kein Ersatz.** Zwei Gründe, und der
zweite wiegt schwerer:

- Ein Snapshot ist ein **Maschinen**zeitpunkt, kein Datenbankzeitpunkt. Er
  friert ein laufendes PostgreSQL mitten in einer Transaktion ein; das ist
  wiederherstellbar, aber es ist Crash-Recovery und keine Sicherung.
- Er lässt sich **nicht bei jeder Änderung erneut beweisen**. Genau das ist der
  Inhalt dieser Entscheidung: nicht dass gesichert *wird*, sondern dass die
  Wiederherstellung **geprobt** ist.

Snapshots des Hosters bleiben trotzdem sinnvoll — als zweite Ebene gegen den
Verlust der ganzen Maschine. Das Betriebshandbuch sagt das; ersetzt wird damit
nichts.

### 2. Die Sicherung hat **drei** Gegenstände, nicht zwei

| Gegenstand | Was | Wo er liegt |
|---|---|---|
| **Datenbank** | `pg_dump -Fc` der ganzen Instanz | im Archiv |
| **Dateien** | das Volume `api-files`, als Tar | im Archiv |
| **`SECRET_BOX_KEY`** | der Schlüssel, mit dem die Zeilen des Archivs entsiegelt werden | ⚠️ **außerhalb des Archivs** |

⚠️ **Der Schlüssel gehört an einen anderen Ort als das Archiv, das er
schützt.** Läge er darin, wäre die Verschlüsselung aus Punkt 3 eine Zierde:
wer das Archiv hat, hätte auch den Schlüssel.

**Der Verlust des Schlüssels ist der stillste denkbare Datenverlust.** Wird mit
einem *anderen* `SECRET_BOX_KEY` wiederhergestellt, ist die Datenbank
vollständig, die Anwendung startet, jede Seite rendert — und erst am
geschützten Formular greift *fail closed* . Es sieht aus wie ein
Anwendungsfehler und ist ein Schlüsselverlust. Die Probe fährt diesen Fall,
statt ihn zu erwähnen.

### 3. Das Archiv ist verschlüsselt

Symmetrisch, mit einem Schlüssel, der **nicht** `SECRET_BOX_KEY` ist
(`BACKUP_KEY`). Zwei getrennte Schlüssel, weil sie verschiedene Fragen
beantworten: der eine schützt einzelne Spalten im laufenden Betrieb, der andere
eine Datei, die das Haus verlässt. Wer nur den einen hat, hat nicht den anderen.

Ohne Schlüssel ist das Archiv nicht lesbar, und mit einem **falschen**
scheitert die Wiederherstellung **lesbar** — nicht mit einer halb entpackten
Datei, die niemand als kaputt erkennt.

### 4. Die Probe prüft, was zurückkam — nicht, dass das Skript lief

Der `restore`-Job der CI fährt: Stack hoch · über die **API** ein Formular
anlegen, veröffentlichen, öffentlich ausfüllen **mit Anlage** · sichern ·
`docker compose down -v` · Stack neu · wiederherstellen · **prüfen**.

Geprüft wird:

- die Antwort ist über die API lesbar,
- **die Anlage lädt herunter und hat dieselbe Prüfsumme**,
- die `mail_log`-Zeile trägt ihren eingefrorenen Rumpf,
- die Anmeldung des gesicherten Kontos funktioniert.

⚠️ **`down -v`, nicht `down`.** Ohne `-v` überlebt das Volume, die Probe stellt
in eine Datenbank wieder her, die Daten noch hat, und **jede** Prüfung ist
grün — auch die, die nichts wiederhergestellt hat. Diese Falle steht in
[`04-build-run.md`](../kb/04-build-run.md) und hat dort schon einmal einen
Nachweis wertlos gemacht.

### 5. Die Aufbewahrung räumt auf — aber nie die jüngste

Ältere Archive verschwinden nach `BACKUP_KEEP_DAYS`. **Das jüngste bleibt,
auch wenn es älter ist als die Frist.** Der Fall, der im Ernstfall zählt: eine
Installation, die vier Wochen niemand gesichert hat, verlöre sonst beim
nächsten Lauf ihre einzige Sicherung — die Aufräumregel würde zum Datenverlust,
den sie verhindern soll.

## Was dieser ADR **nicht** entscheidet

- **Wohin die Archive gehen.** Das Skript schreibt in ein Verzeichnis; ob das
  ein zweiter Datenträger, ein S3-Eimer oder ein `rsync`-Ziel ist, entscheidet
  der Betreiber. Was es *nicht* sein darf, steht im Betriebshandbuch: derselbe
  Datenträger, den es sichert.
- **Wie oft gesichert wird.** Ein Zeitplan gehört auf die Maschine (cron,
  systemd-timer), nicht in den Anwendungscode — dieselbe Grenze, an der auch
  `TRASH_RETENTION_DAYS` und die Purge-Intervalle liegen.
- **Point-in-Time-Recovery** (WAL-Archivierung). Sie beantwortet eine andere
  Frage („zurück auf 14:32 Uhr") und kostet einen laufenden Archivstrom. Bei
  ~50 Organisationen und Formularen mit Wochenfristen ist ein Tagesstand die Zusage,
  die trägt.

## Consequences

- **Zwei neue Skripte und ein neuer CI-Job.** Der Job ist der teuerste
  einzelne Nachweis hier; er fährt einen ganzen Stack zweimal.
- **Ein neues Geheimnis** (`BACKUP_KEY`) in der Betriebsanleitung — und die
  Pflicht, es getrennt von `SECRET_BOX_KEY` und getrennt vom Archiv
  aufzubewahren.
- **Der Betreiber bekommt eine Pflicht, die er vorher nicht hatte:** die erste
  echte Wiederherstellungsprobe auf der Produktivmaschine. Sie
  beantwortet die eine Frage, die CI nicht beantworten kann — **wie lange
  dauert es, und reicht der Platz?**

## References

- [ADR-0014](0014-datei-upload.md) (warum die Bytes nicht in der Datenbank
  liegen — und damit der Grund für den zweiten Gegenstand)
- [`04-build-run.md`](../kb/04-build-run.md) („Die Compose-Datenbank und ihre
  zwei Fallen", `down -v`)
