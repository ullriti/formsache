# Betrieb

- [Betrieb](#betrieb)
  - [Installation](#installation)
  - [Die .env der Produktion](#die-env-der-produktion)
    - [Was der Stack liest](#was-der-stack-liest)
    - [Nur für die Skripte](#nur-für-die-skripte)
    - [Was die Anwendung liest](#was-die-anwendung-liest)
  - [Betrieb ohne TLS](#betrieb-ohne-tls)
  - [Mailserver einrichten](#mailserver-einrichten)
    - [Einladungen](#einladungen)
  - [Täglich](#täglich)
  - [Wöchentlich](#wöchentlich)
  - [Der äußere Beobachter](#der-äußere-beobachter)
  - [Sicherung](#sicherung)
  - [Wiederherstellung](#wiederherstellung)
  - [Woher eine Fassung kommt](#woher-eine-fassung-kommt)
  - [Welche Marke ziehen?](#welche-marke-ziehen)
  - [Ein Release ausrollen](#ein-release-ausrollen)
  - [Der Rückweg](#der-rückweg)
  - [Störfälle](#störfälle)
    - [Störfall 1 — der Mailserver antwortet nicht](#störfall-1--der-mailserver-antwortet-nicht)
    - [Störfall 2 — der Datenträger läuft voll](#störfall-2--der-datenträger-läuft-voll)
    - [Störfall 3 — ein Aufräumlauf bleibt aus](#störfall-3--ein-aufräumlauf-bleibt-aus)
    - [Störfall 4 — die Datenbank ist weg](#störfall-4--die-datenbank-ist-weg)
    - [Störfall 5 — der KI-Anbieter antwortet nicht](#störfall-5--der-ki-anbieter-antwortet-nicht)
    - [Störfall 6 — die SSO-Anmeldung schlägt fehl](#störfall-6--die-sso-anmeldung-schlägt-fehl)
  - [Betroffenenanfrage nach DSGVO](#betroffenenanfrage-nach-dsgvo)
  - [Die KI einschalten](#die-ki-einschalten)

Fristen und Betroffenenrechte: [`10-datenschutz.md`](10-datenschutz.md).
Entwicklungsumgebung und Pipeline: [`04-build-run.md`](04-build-run.md).

## Installation

Voraussetzungen: ein Linux-Host mit Docker und Docker Compose v2,
`postgresql-client-17` auf dem Host (für die Sicherung), ein DNS-Name auf die
Maschine und ein **Reverse-Proxy mit TLS** — den stellt der Betreiber, das
Projekt bringt keinen mit.

**1. Dateien holen**

```bash
git clone https://github.com/ullriti/formsache.git /opt/formsache
cd /opt/formsache
```

**2. `.env` anlegen**

```bash
./scripts/prod-setup.sh          # legt .env aus .env.prod.example an
```

Das Skript erzeugt `SECRET_BOX_KEY`, `BACKUP_KEY` und `POSTGRES_PASSWORD`, gibt
keinen davon aus, überschreibt keine vorhandene `.env` und fasst keinen
gesetzten Wert an. Ein zweiter Lauf nach einem `git pull` trägt nur nach, was
die Vorlage dazugelernt hat.

⚠️ **`SECRET_BOX_KEY` und `BACKUP_KEY` gehören ab jetzt zur Sicherung** — an
einen Ort außerhalb dieser Maschine und außerhalb des Archivs.

**3. Stack starten**

```bash
docker compose -f docker-compose.prod.yml up -d
```

`migrate` läuft zuerst und endet, dann `api`, dann `web`.
`docker compose -f docker-compose.prod.yml ps` zeigt `api` als **healthy**,
sobald die Datenbank steht.

**4. Reverse-Proxy davorhängen**

Die Produktivdatei veröffentlicht **keinen Port**. Der Dienst `web` nimmt im
Container-Netz auf **8080** an: entweder den Port auf Loopback veröffentlichen
(`127.0.0.1:8080:8080`) oder den eigenen Proxy dem Compose-Netz beitreten
lassen. Beide Wege stehen in `docker-compose.prod.yml` auskommentiert.

**5. Einrichten**

Solange die Installation kein Konto hat, zeigt sie unter der Basis-Adresse den
**Einrichtungsassistenten**
([ADR-0022](../architecture/0022-erstinbetriebnahme.md)): sieben Schritte durch
alle Systemeinstellungen, jeder mit dem Satz, was ohne ihn nicht geht.

| # | Schritt | Was ohne ihn nicht geht |
|---|---|---|
| 1 | **Dein Zugang** — Name, E-Mail, Passwort ab 12 Zeichen | alles; als einziger **nicht** überspringbar |
| 2 | **Basis-Adresse** — aus der Aufruf-Adresse vorbelegt, aber zu bestätigen | Links in Mails bleiben unaufgelöst (Bearbeiten-Link, Rücksetz-Link) |
| 3 | **Mailserver der Instanz** | die Installation verschickt nichts — und **kein neues Konto entsteht**, siehe unten |
| 4 | **Antwortadresse und Betreiberadresse** | ein Betriebsalarm erreicht niemanden |
| 5 | **Benachrichtigungs-Vorlagen** | es gelten die ausgelieferten drei |
| 6 | **KI** | die KI-Formularerstellung ist abwesend |
| 7 | **Erste Organisation** | niemand kann ein Formular anlegen |

Nach Schritt 1 meldet der Assistent sich mit den eben getippten Zugangsdaten
gewöhnlich an; die Schritte 2 bis 7 sind angemeldete Routen. Was offen bleibt,
steht danach **über den Reitern der Systemverwaltung** als Liste offener Punkte
— abgeleitet aus dem tatsächlichen Zustand und nicht aus einem Merker: sie
verschwindet von selbst, sobald der Punkt erledigt ist, gleich wo.

Jede Organisation hat denselben Ablauf noch einmal für sich
([ADR-0025](../architecture/0025-ersteinrichtung-einer-organisation.md)): acht
Schritte unter `/admin/setup`, alle überspringbar. Solange sie kein
Formular hat und etwas offen ist, lädt ihr Dashboard dazu ein; danach steht
dort nur noch die Liste ihrer offenen Punkte.

⚠️ **Die Testmail aus Schritt 3 lässt sich dort noch nicht senden.** Jeder
Versand wird im Versandprotokoll einer Organisation abgelegt, und die erste
entsteht erst in Schritt 7. Nachholen unter *Systemverwaltung → Mailserver* —
sichtbares Ergebnis ist die zugestellte Nachricht, nicht die gespeicherte
Konfiguration.

Wer die Einrichtungsseite nie freigeben will, nimmt statt ihrer den Befehl:

```bash
scripts/create-superadmin.sh --email vorstand@example.org --name 'Vorstand' \
  --tenant-short DACH --tenant-name 'Dachorganisation'
```

Das Passwort fragt das Skript verdeckt und zweimal ab (automatisiert:
`FORMSACHE_ADMIN_PASSWORD`; auf der Kommandozeile wird es abgewiesen). Beide
Wege legen nichts an, sobald es Konten gibt.

⚠️ **Einen zweiten Superadministrator anlegen — vor dem Notfall, nicht in
ihm.** Weil beide Wege oben nach dem ersten Konto verschlossen sind, gibt es
den dritten: *Systemverwaltung → Superadmins*. Dort wird ein **vorhandenes**
Konto über seine E-Mail-Adresse ernannt, und eine Ernennung lässt sich
zurücknehmen.

Warum das nicht warten sollte: mit nur einer Ernennung ist diese Person ein
Einzelpunkt des Ausfalls — verliert sie ihren Zugang oder scheidet sie aus,
kommt an die Systemverwaltung niemand mehr heran, und der Weg zurück führt
über die Datenbank. Die letzte Ernennung lässt sich deshalb nicht
zurücknehmen; die Oberfläche weist das mit einer Begründung ab.

Eine Person **ohne Mitgliedschaft in einer Organisation** kann ihre Ernennung
nicht verlieren: ihr Konto hätte danach keinen Ort mehr und würde vom
Aufräumlauf endgültig gelöscht. Die Liste zeigt das vorher an — erst in eine
Organisation aufnehmen, dann die Ernennung zurücknehmen
([ADR-0029](../architecture/0029-zweiter-superadministrator.md)).

**6. Rauchtest**

```bash
SMOKE_EMAIL=… SMOKE_PASSWORD=… scripts/smoke.sh https://<basis-adresse>
```

Sieben Zusagen: Bereitschaft, Anmeldung, öffentliches Formular, Mailweg, Anlage
mit gleicher Prüfsumme zurück, Export, Schemastand. Das Konto braucht
*Formulare bauen*, *Antworten sehen*, *exportieren* und *Einstellungen
verwalten* — das letzte, weil der Lauf eine Benachrichtigung anlegt, ohne die
nie eine `mail_log`-Zeile entstünde.

⚠️ **Die Organisation, in der der Lauf arbeitet, braucht ihren eigenen
Mailserver.** Zusage 4 misst Formularpost, und die geht über den Mailserver der
Organisation, nicht über den der Installation. Fehlt er, bleibt die Zeile auf
`queued` — zurückgehalten, nicht gescheitert — und der Lauf meldet „der
Mail-Worker arbeitet nicht", obwohl der Worker in Ordnung ist.

**7. Sicherung und äußeren Beobachter einrichten** — beides gehört zur
Installation, nicht zur Nacharbeit.

## Die .env der Produktion

Angelegt von `scripts/prod-setup.sh` aus `.env.prod.example`.

### Was der Stack liest

<!-- env-contract:host -->

| Variable | Status | Vorgabe | Wozu |
|---|---|---|---|
| `IMAGE_PREFIX` | Vorgabe | `ghcr.io/ullriti` | Registry-Präfix der Images |
| `APP_VERSION` | Vorgabe | `latest` | Der Stand, den diese Installation fährt — siehe [Welche Marke ziehen?](#welche-marke-ziehen). Alle Marken: <https://github.com/ullriti/formsache/pkgs/container/formsache-api> |
| `POSTGRES_USER` | Vorgabe | `formsache` | Rolle der Datenbank |
| `POSTGRES_PASSWORD` | Pflicht | — | Passwort der Rolle; ohne startet der Stack nicht |
| `POSTGRES_DB` | Vorgabe | `formsache` | Name der Datenbank |
| `SECRET_BOX_KEY` | Pflicht | — | Entsiegelt Zugangswörter, SMTP-Passwörter, OIDC-Secrets, KI-Schlüssel |
| `SESSION_TTL_HOURS` | Vorgabe | `12` | Lebensdauer einer Anmeldung (1 bis 720) |
| `SESSION_COOKIE_SECURE` | Vorgabe | `true` | `Secure` und der `__Host-`-Name am Sitzungs-Cookie. ⚠️ `false` nur für [Betrieb ohne TLS](#betrieb-ohne-tls) |
| `OIDC_ISSUER_ALLOWLIST` | Vorgabe | leer | Hosts, deren OIDC-Discovery abgerufen werden darf. Leer = jeder öffentliche Host |
| `TRUSTED_PROXY_CIDR` | Vorgabe | `172.16.0.0/12` | Aus welchem Netz der Frontdoor ein `X-Forwarded-For` glaubt. Zu weit heißt: ein erfundener Kopfeintrag umgeht das Rate-Limit |
| `MAIL_WORKER_INTERVAL_MS` | Vorgabe | `15000` | Takt der Mail-Warteschlange |
| `MAIL_PURGE_INTERVAL_MS` | Vorgabe | `86400000` | Takt des Aufräumens im Versandprotokoll |
| `FILE_PURGE_INTERVAL_MS` | Vorgabe | `86400000` | Takt des Aufräumens unbeanspruchter Anlagen |
| `TRASH_PURGE_INTERVAL_MS` | Vorgabe | `86400000` | Takt des Papierkorb-Aufräumens |
| `SESSION_PURGE_INTERVAL_MS` | Vorgabe | `86400000` | Takt des Aufräumens toter Sitzungen |
| `AI_USAGE_PURGE_INTERVAL_MS` | Vorgabe | `86400000` | Takt des Aufräumens der KI-Nutzungszeilen |
| `AI_REQUEST_TIMEOUT_MS` | Vorgabe | `60000` | Zeitlimit einer KI-Erzeugung |
| `OPS_ALERT_INTERVAL_MS` | Vorgabe | `300000` | Takt des Betriebswächters; `0` schaltet die Alarmierung ab |

<!-- /env-contract:host -->

⚠️ **Die Takte verschieben nur den Zeitpunkt, nie die Frist** — die Fristen
stehen im Code ([`10-datenschutz.md`](10-datenschutz.md)). Ein Takt auf `0`
heißt: es wird nie gelöscht.

### Nur für die Skripte

Diese drei liest kein Container, sondern `scripts/backup.sh` und
`scripts/restore.sh` auf dem Host. Datenbankadresse und Upload-Verzeichnis
ermitteln die beiden selbst — es genügt ihnen der laufende **`db`**-Dienst,
denn genau der ist bei einer Wiederherstellung als einziger oben.

| Variable | Status | Vorgabe | Wozu |
|---|---|---|---|
| `BACKUP_KEY` | Pflicht | — | Schlüssel des Sicherungsarchivs. **Nicht** `SECRET_BOX_KEY` |
| `BACKUP_DIR` | Vorgabe | `/var/backups/formsache` | Wohin gesichert wird — nicht auf den Datenträger, den es sichert |
| `BACKUP_KEEP_DAYS` | Vorgabe | `30` | Wie lange Archive dort bleiben |

### Was die Anwendung liest

Das Zod-Schema (`packages/shared/src/env.ts`) ist die Wahrheit; fehlt eine
Pflichtzeile, startet die API nicht und nennt sie. `NODE_ENV`, `API_PORT`,
`DATABASE_URL`, `FILE_STORAGE_DIR` und `TRUST_PROXY_HOPS` setzt
`docker-compose.prod.yml` am Dienst fest — sie stehen **nicht** in der `.env`.

<!-- env-contract:app -->

| Variable | Status | Vorgabe | Wozu |
|---|---|---|---|
| `NODE_ENV` | Pflicht | — | Betriebsmodus; entscheidet die **Vorgabe** von `SESSION_COOKIE_SECURE` |
| `DATABASE_URL` | Pflicht | — | Verbindung zur Datenbank; im Stack aus den `POSTGRES_*` gebaut |
| `SECRET_BOX_KEY` | Pflicht | — | Schlüssel der versiegelten Spalten |
| `FILE_STORAGE_DIR` | Pflicht | — | Wo die Anlagen liegen; im Container `/var/lib/formsache/files` aus einem Volume |
| `API_PORT` | Vorgabe | `3000` | Port der API im Container |
| `APP_VERSION` | Vorgabe | `0.0.0-dev` | Was `/api/health` und *Überwachung* melden |
| `SESSION_TTL_HOURS` | Vorgabe | `12` | Lebensdauer einer Anmeldung |
| `SESSION_COOKIE_SECURE` | Vorgabe | wie `NODE_ENV` | `Secure` und der `__Host-`-Name am Sitzungs-Cookie; im Produktionsstapel `true` |
| `TRUST_PROXY_HOPS` | Vorgabe | `0` | Vertraute Proxy-Sprünge vor der API; im Stack `1` |
| `MAIL_WORKER_INTERVAL_MS` | Vorgabe | `15000` | Takt der Mail-Warteschlange |
| `MAIL_PURGE_INTERVAL_MS` | Vorgabe | `86400000` | Takt des `mail_log`-Aufräumens |
| `FILE_PURGE_INTERVAL_MS` | Vorgabe | `86400000` | Takt des Datei-Aufräumens |
| `TRASH_PURGE_INTERVAL_MS` | Vorgabe | `86400000` | Takt des Papierkorb-Aufräumens |
| `SESSION_PURGE_INTERVAL_MS` | Vorgabe | `86400000` | Takt des Sitzungs-Aufräumens |
| `OIDC_ISSUER_ALLOWLIST` | Vorgabe | leer | Erlaubte Hosts für die OIDC-Discovery |
| `AI_USAGE_PURGE_INTERVAL_MS` | Vorgabe | `86400000` | Takt des KI-Aufräumens |
| `AI_REQUEST_TIMEOUT_MS` | Vorgabe | `60000` | Geduld gegenüber dem KI-Anbieter |
| `OPS_ALERT_INTERVAL_MS` | Vorgabe | `300000` | Takt des Betriebswächters |

<!-- /env-contract:app -->

`TRUST_PROXY_HOPS` entscheidet seit der Adress-Vorauswahl auf der Anmeldeseite
auch, welchen Host `GET /api/auth/oidc/providers` glaubt (siehe
`OidcLoginController.providers`). Steht der Wert auf `0`, während ein Proxy
davorsitzt, greift die Vorauswahl nie — die Anmeldung funktioniert unverändert.

SMTP, Basis-Adresse und KI-Konfiguration sind **keine** Umgebungsvariablen: sie
stehen als Systemeinstellung in der Datenbank und werden in der Oberfläche
gepflegt.

## Betrieb ohne TLS

⚠️ **Nur im eigenen Netz, niemals für eine öffentlich erreichbare
Installation.** Wer diesen Abschnitt braucht, betreibt Formsache über plain
http — etwa auf einem Gerät im Vereinsnetz, das über seine IP-Adresse
angesprochen wird. Alles andere in diesem Handbuch setzt einen Reverse-Proxy
mit TLS voraus, und das ist die richtige Gestalt.

**Das Symptom, wenn man es nicht einstellt.** Die Anmeldung antwortet mit 200,
und die nächste Anfrage ist trotzdem nicht angemeldet — über `http://localhost`
geht es, über `http://192.168.1.10` oder einen Hostnamen ohne TLS nicht. Der
Grund liegt im Browser: ein `Secure`-Cookie nimmt er auf der Loopback-Adresse
an (die gilt als sicherer Kontext), über jede andere http-Adresse **verwirft er
es wortlos**. Der Server hat es korrekt gesetzt, angekommen ist es nie.

**Die Einstellung.** In der `.env`:

```
SESSION_COOKIE_SECURE=false
```

Danach `docker compose -f docker-compose.prod.yml up -d api`. Die API schreibt
beim Start eine Zeile, die sagt, welche Fassung gilt — in diesem Fall als
**Warnung**, weil `production` ohne `Secure` die eine Kombination ist, die
jemand ausdrücklich verlangt haben muss:

```
Session cookie: no Secure, named formsache_session (SESSION_COOKIE_SECURE=false)
  — suitable only for operation without TLS in a private network; …
```

Fehlt diese Zeile oder nennt sie `__Host-formsache_session`, ist der Wert nicht
angekommen — der Zustand ist ohne Browser-Werkzeuge ablesbar, und das ist der
Zweck der Zeile.

**Was es kostet.** Ohne `Secure` fällt auch der `__Host-`-Präfix am
Cookie-Namen weg; der Präfix *verlangt* `Secure`, ein Browser würde ein solches
Cookie sonst verweigern. Mit dem Präfix geht der einzige Schutz gegen
**Cookie-Tossing**: eine Nachbardomain unter derselben Elterndomain — eine
Werbeseite, ein kompromittierter Nebendienst — kann dann ein Cookie namens
`formsache_session` für die Elterndomain schreiben, und der Server kann es nicht
von seinem eigenen unterscheiden. Das reicht von „Nutzer werden abgemeldet" bis
zu „eine fremd gewählte Sitzungskennung wird jemandem untergeschoben". Über
plain http kommt hinzu, dass jeder im selben Netz das Cookie ohnehin mitlesen
kann. Die vollständige Begründung steht im Code
(`apps/api/src/auth/session-cookie.ts`).

**Ein Wechsel des Wertes meldet alle ab.** Der Name des Cookies hängt am Wert,
und ein Browser, der noch den alten Namen hält, legt ein Cookie vor, das der
Server nicht mehr annimmt. Das ist eine richtige Zwangsabmeldung, kein Fehler —
aber es ist keine Änderung für den Feierabend vor der Jahrestagung.

**Was zusätzlich zu tun ist.** Die **Anmeldung über SSO** scheitert, solange die
**Basis-Adresse** nicht die tatsächliche ist: die `redirect_uri` und der Rückweg
in die Anwendung entstehen aus ihr und nie aus der Aufruf-Adresse — eine
geratene Herkunft an dieser Stelle wäre ein offener Weiterleiter
([ADR-0005](../architecture/0005-auth-sessions-oidc.md),
`apps/api/src/common/public-url/public-url.service.ts`). Wer über eine
IP-Adresse arbeitet, trägt genau diese Adresse als Basis-Adresse ein — dann
stimmen auch die Links in den Mails. Ob der eigene Anmeldedienst eine
`http`-`redirect_uri` überhaupt annimmt, entscheidet er selbst; viele tun es nur
für `localhost`.

## Mailserver einrichten

**Es wird nichts vererbt** ([ADR-0023](../architecture/0023-getrennte-mailserver-instanz-organisation.md)).

| Ebene | Wo | Wofür |
|---|---|---|
| Instanz | *Systemverwaltung → Mailserver* | Betriebsalarme, Testmail — und jede **Kontomail**: Einladung, Passwort-Rücksetzung, Mitteilung über ein gesetztes Passwort |
| Organisation | *Organisations-Verwaltung → Mailversand* | alles, was diese Organisation verschickt: Bestätigungen, Benachrichtigungen, Erinnerungen |

Eine Kontomail geht **nie** über den Mailserver einer Organisation: wer dort
`can_manage_settings` hält, bekäme sonst den fertigen Link zu einem fremden
Konto in sein Relay.

⚠️ **Ohne Mailserver der Instanz lässt sich keine Person anlegen**
([ADR-0024](../architecture/0024-einladung-statt-getipptem-passwort.md)). Ein
neues Konto bekommt kein getipptes Passwort mehr, sondern eine Einladung — und
weil die ohne Mailserver nicht hinausginge, wird das Anlegen **vorher**
abgelehnt (422 mit dem Satz, wo es zu beheben ist), statt ein Konto zu
hinterlassen, in das niemand hineinkommt. Dasselbe gilt für die erste
Administratorin einer neuen Organisation. Zwei Wege bleiben ohne ihn offen:
„mich selbst eintragen" und eine Adresse, die schon ein Konto hat — beide
verschicken nichts.

⚠️ **Eine Organisation ohne Mailserver versendet nicht.** Ihre Nachrichten
bleiben mit lesbarem Grund in der Warteschlange, bis jemand einen einträgt;
verloren geht nichts. Nach dem Eintragen **Testmail** senden: sichtbares
Ergebnis ist die zugestellte Nachricht, nicht die gespeicherte Konfiguration.

### Einladungen

Eingeladene setzen ihr Passwort über einen einmaligen Link, der **sieben Tage**
gilt; niemand sonst kennt es. Ein SSO-Konto bekommt statt des Links den
Anmeldeweg genannt — die Adresse und die Aufschrift der Schaltfläche dieser
Organisation. Kam die Mail nicht an, steht in
*Organisations-Verwaltung → Nutzerrechte* bei jedem Mitglied **„Einladung erneut
senden"** — ein neuer Link entwertet die älteren. Ein Konto, das es schon gab
und das nur an eine weitere Organisation angehängt wurde, bekommt keine
Einladung: es kennt sein Passwort. Wer gar nicht mehr hineinkommt, geht über
„Passwort vergessen"; als letzter Weg bleibt das administrativ gesetzte
Passwort in derselben Ansicht.

## Täglich

**Systemverwaltung → Überwachung**, dreißig Sekunden. Grün heißt, dass keine
Schwelle gerissen ist.

| Zahlengruppe | Wenn sie rot ist |
|---|---|
| **Warteschlange** — wartend, gescheitert, Alter der ältesten | Post geht nicht raus → [Störfall 1](#störfall-1--der-mailserver-antwortet-nicht) |
| **Ablage** — Dateien, belegt, Datenträger | Uploads scheitern bald → [Störfall 2](#störfall-2--der-datenträger-läuft-voll) |
| **KI** — Aufrufe, Fehlerquote | Anbieter unzuverlässig → [Störfall 5](#störfall-5--der-ki-anbieter-antwortet-nicht) |
| **Hintergrundläufe** — je Lauf „zuletzt erfolgreich" | ⚠️ Löschfristen laufen darüber → [Störfall 3](#störfall-3--ein-aufräumlauf-bleibt-aus) |
| **Fassung** | Dieselbe Zahl, die `curl https://<basis>/api/health` nennt |

Die Schwellen lösen eine Mail an die Betreiberadresse aus
([ADR-0016](../architecture/0016-betriebsueberwachung-und-alarmierung.md)).
⚠️ Ein toter Mailserver kann seinen eigenen Ausfall nicht melden — dafür gibt
es den äußeren Beobachter, und deshalb meldet der auf einem anderen Kanal.

## Wöchentlich

1. **Die letzte Sicherung ansehen** — liegt ein Archiv von heute Nacht da, und
   lässt es sich aufschließen?

   ```bash
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
     -in /pfad/formsache-backup-….tar.gz.enc -pass env:BACKUP_KEY \
     | tar -xzOf - manifest.txt
   ```

   Sichtbar: `created_at`, `app_version`, `migration`,
   `secret_box_key_fingerprint`, zwei Prüfsummen. Dass der Befehl durchläuft,
   beweist zugleich, dass der `BACKUP_KEY` in der Hand zu diesem Archiv gehört.

2. **Alarme sichten** — im Postfach der Betreiberadresse, nicht in der
   Anwendung. Kam etwas, das weggeklickt wurde — und kam überhaupt je etwas an?

3. **Quartalsweise eine Wiederherstellung proben**, aus der Sicherung der
   Produktivinstallation in eine zweite Umgebung. Protokolleintrag mit Datum,
   Dauer, Archivgröße und Abweichungen.

## Der äußere Beobachter

Der einzige Teil der Überwachung, der außerhalb dieser Installation wohnt — und
der einzige, der den Totalausfall sieht.

- **Fragt:** `GET https://<basis-adresse>/api/health/ready`, alle 60 Sekunden.
- **Erwartet:** HTTP 200. **503** heißt „Anwendung lebt, Datenbank nicht",
  keine Antwort heißt Totalausfall.
- **Meldet an:** ⚠️ einen **anderen** Kanal als der innere Alarm — sonst nimmt
  ein Mailausfall den Meldeweg mit, der ihn melden soll.
- **Einmal auslösen**, bevor man sich darauf verlässt: kurz auf eine Adresse
  zeigen lassen, die es nicht gibt, und auf die Meldung warten.

## Sicherung

```bash
BACKUP_KEY=… scripts/backup.sh --out /pfad/zum/sicherungsziel
```

Drei Dinge gehören auswendig gewusst
([ADR-0017](../architecture/0017-sicherung-und-wiederherstellung.md)):

1. **Die Sicherung hat drei Gegenstände:** Datenbank, Dateien — und
   `SECRET_BOX_KEY`. Der Schlüssel liegt nicht im Archiv, er entsiegelt es.
2. **Das Ziel ist nicht der Datenträger, den es sichert.**
3. **`BACKUP_KEY` ist ein zweites Geheimnis** und liegt wieder woanders.

⚠️ **`pg_dump` muss mindestens so neu sein wie der Server** (PostgreSQL 17).
Ein älterer Client bricht mit „aborting because of server version mismatch" ab,
während `psql` weiter funktioniert. Prüfen mit `pg_dump --version`.

**Gelaufen ist ein Lauf, wenn** auf dem Ziel eine Datei
`formsache-backup-<Zeitstempel>.tar.gz.enc` liegt — egal, was im Protokoll
steht.

⚠️ **Eine Warnung bleibt trotzdem eine:** meldet der Lauf „der Migrationsstand
ließ sich nicht ermitteln", ist das Archiv vollständig, aber das Manifest sagt
`migration=unbekannt` — und damit fehlt vor einem Einspielen die Angabe, die
zählt. Der Grund ist fast immer eine `.env`, die dem Cron nicht vorliegt, oder
ein abweichender `POSTGRES_USER`. Abgebrochen wird deswegen nicht: ein Archiv
ohne diese Zeile ist mehr wert als kein Archiv.

**Zeitplan:** ein `cron`- oder `systemd`-Eintrag, täglich nachts. ⚠️ Ein
`cron`-Eintrag hat keine Erfolgsmeldung; Punkt 1 der Wochenliste ist die
einzige Rückmeldung, die er hat.

## Wiederherstellung

Die Reihenfolge ist Teil der Zusage.

```bash
# 1. Anwendung anhalten — die Datenbank bleibt an
docker compose -f docker-compose.prod.yml stop api web
docker compose -f docker-compose.prod.yml up -d db

# 2. Datenbank und Dateien zurück
BACKUP_KEY=… SECRET_BOX_KEY=… scripts/restore.sh /pfad/formsache-backup-….tar.gz.enc

# 3. Migrationen nachziehen — NACH dem Einspielen
docker compose -f docker-compose.prod.yml run --rm migrate

# 4. Stack an
docker compose -f docker-compose.prod.yml up -d

# 5. Rauchtest
scripts/smoke.sh https://<basis-adresse>
```

⚠️ **Kein `down`, und kein laufender `api`** — beides bricht die
Wiederherstellung, und zwar in entgegengesetzte Richtungen:

- `down` nimmt `scripts/restore.sh` die beiden Dinge, die es braucht. Das
  Skript läuft **neben** den Containern: ohne `db` gibt es keine erreichbare
  Datenbank (die Produktivdatei veröffentlicht keinen Port) und keinen Weg zum
  Upload-Volume. Es bricht dann mit dem Hinweis auf `up -d db` ab.
- Ein laufender `api` schreibt in die Datenbank, die gerade ersetzt wird —
  `pg_restore --clean` zieht ihm die Tabellen unter den Füßen weg. `restore.sh`
  prüft das und bricht mit dem Verweis auf `stop api web` ab.

Ist der Stack ohnehin schon aus, genügt Zeile zwei von Schritt 1.

**Warum `migrate` danach:** das Archiv bringt sein eigenes Schema mit; vorher
gelaufen, schriebe die Migration in eine Datenbank, die gleich überschrieben
wird.

`restore.sh` prüft vorher die Prüfsummen aus dem Manifest und den
**Fingerabdruck von `SECRET_BOX_KEY`**. ⚠️ Mit einem falschen Schlüssel ist die
Datenbank vollständig, die Anwendung startet, jede Seite rendert — und
geschützte Formulare lassen niemanden mehr durch. Es sieht aus wie ein
Anwendungsfehler und ist ein Schlüsselverlust.

**Danach von Hand prüfen:** eine Antwort mit Anlage öffnen und die Anlage
**herunterladen**. Wiederherstellungen scheitern an den Dateien, nicht an der
Datenbank.

## Woher eine Fassung kommt

Es gibt keinen Release-Knopf und keinen Tag von Hand. **Jeder Push auf `main`,
der die Pipeline grün durchläuft, ist eine Fassung** — veröffentlicht wird erst,
wenn `quality`, `test`, `e2e`, `stack` und `restore` im selben Lauf grün sind,
ein roter Stand veröffentlicht also nichts. Die Nummer leitet GitVersion aus den
Commit-Typen ab (`feat:` hebt die zweite Stelle, `fix:`/`perf:` die dritte, ein
`!` die erste), und die Pipeline schreibt sie anschließend als Tag `vX.Y.Z`
zurück (ADR-0009).

Zwei Folgen für den Betrieb:

- **Ein reiner Doku-Push veröffentlicht nichts.** Es bleibt beim Image des
  letzten Laufs mit Code.
- **Fassungen erscheinen häufig**, auch aus reinen Abhängigkeits-Aktualisierungen.
  Das ist Absicht — so erreicht ein Sicherheitspatch eine Installation, die `x`
  oder `x.y` folgt, ohne Zutun. Wer das nicht will, nagelt `x.y.z` fest und
  aktualisiert bewusst.

⚠️ **`CHANGELOG.md` ist deshalb keine Fassungsliste**, sondern eine kuratierte
Sammlung dessen, was der Rede wert ist. Was eine bestimmte Fassung enthält,
beantwortet die Commit-Historie zwischen zwei Tags.

## Welche Marke ziehen?

Jedes Release veröffentlicht fünf Marken je Image, und die Wahl ist eine
Betriebsentscheidung (ADR-0009):

| Marke | Beispiel | Bewegt sich | Wofür |
|---|---|---|---|
| `x.y.z` | `1.4.2` | nie | Produktion. Der Stand ist festgenagelt, der Rückweg ist „die vorherige Zahl". |
| `sha-<commit>` | `sha-9f3c…` | nie | Eindeutig auch dann, wenn zwei Läufe dieselbe SemVer tragen. Für die Fehlersuche. |
| `x.y` | `1.4` | mit jedem Patch | „Fehlerbehebungen ja, neue Fassung nein." |
| `x` | `1` | mit jedem Minor | „Alles, was verträglich bleibt." |
| `latest` | — | mit jedem Release | Ausprobieren, Demo, erste Installation. |

**Empfehlung für den echten Betrieb: `x.y.z`.** Nur damit steht in der `.env`,
was läuft, und nur damit ist der Rückweg eine Zahl statt einer Recherche. `x`
und `x.y` sind für Installationen gedacht, die eine Aktualisierung automatisch
ziehen wollen — dann aber bitte mit der Sicherung aus Schritt 1 unten, denn
auch eine Patch-Fassung kann eine Migration mitbringen.

⚠️ **Die drei beweglichen Marken zeigen nie auf eine Vorabfassung**; sie
entstehen nur auf einer stabilen Fassung aus `main`.

## Ein Release ausrollen

1. **Vorher sichern** — jetzt, nicht die von heute Nacht. Das Manifest hält den
   Migrationsstand fest, auf den man zurückfiele.
2. `APP_VERSION` in der `.env` setzen, dann
   `docker compose -f docker-compose.prod.yml up -d`. Der `migrate`-Dienst
   nennt jede angewandte Migration oder „No pending migrations".
3. `curl https://<basis>/api/health` nennt die Version, die **läuft**.
4. **Rauchtest** und ein Blick auf *Überwachung*.

## Der Rückweg

Welcher gilt, entscheidet eine Frage, und die stellt man **vor** dem Ausrollen:
**bringt dieses Release eine Migration?** Ablesbar am Manifest der letzten
Sicherung gegen den Stand der Installation:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in /pfad/formsache-backup-<vor-dem-release>.tar.gz.enc -pass env:BACKUP_KEY \
  | tar -xzOf - manifest.txt | grep '^migration='

docker compose -f docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  'select migration_name from _prisma_migrations where finished_at is not null
     order by finished_at desc limit 1'
```

| Lage | Weg | Kosten |
|---|---|---|
| **ohne** Migration | `APP_VERSION` auf die vorherige Fassung, `docker compose -f docker-compose.prod.yml up -d` | Minuten, kein Datenverlust |
| **mit** Migration (zwei verschiedene Namen) | altes Tag ziehen **und** die [Wiederherstellung](#wiederherstellung) fahren | alles seit der Sicherung ist weg |

⚠️ **Prisma kennt kein „down".** Hinter eine Migration führt nur die Sicherung
zurück. Nach dem teuren Weg zusätzlich eine Anlage herunterladen — und den
Organisationen sagen, dass Anmeldungen seit dem Stand der Sicherung erneut
ausgefüllt werden müssen. Bereits versendete Bestätigungen lassen sich nicht
zurückholen.

## Störfälle

### Störfall 1 — der Mailserver antwortet nicht

*Gemessen: `apps/api/test/incidents/mail-server-down.spec.ts`.*

- **Symptom:** „wartend" steigt, das Alter der ältesten wächst über 30 Minuten,
  Alarm „Post bleibt liegen". Nach fünf Versuchen (1, 2, 4, 8 Minuten Abstand)
  wandert die Zahl nach „gescheitert". **Das Ausfüllen läuft weiter** —
  Antworten werden angenommen, nur ihre Mail wartet.
- **Prüfung:** Mailserver der betroffenen Ebene ansehen und Testmail senden —
  *Systemverwaltung → Mailserver* für Betriebs- und Kontomails,
  *Organisations-Verwaltung → Mailversand* für die Post einer Organisation.
- **Behebung:** `queued` bleibt `queued`, bis ein Server antwortet; nichts zu
  tun ist zulässig, solange der Ausfall kürzer ist als die fünf Versuche.
  ⚠️ **`failed`-Zeilen laufen nicht von selbst wieder an:** im Versandprotokoll
  der Organisation je Zeile **„↻ Erneut"**. Kontomails haben den Knopf nicht —
  eine Einladung wird über „Einladung erneut senden" neu verschickt, eine
  Rücksetzung über „Passwort vergessen" neu angefordert.
- **Vorbei, wenn:** die Warteschlange fällt und „Alter der ältesten" leer ist.
  Eine gleichbleibende Zahl bei „gescheitert" ist keine Erholung, sondern die
  Liste der offenen Arbeit.

### Störfall 2 — der Datenträger läuft voll

- **Symptom:** die Ablage steht über 85 %, Alarm „Der Datenträger füllt sich".
  Ist er wirklich voll, scheitern **Uploads** mit 500, während jede andere
  Seite funktioniert.
- **Behebung, in dieser Reihenfolge:** alte Sicherungen von **diesem**
  Datenträger wegräumen (`du -sh` auf dem Sicherungsziel) → prüfen, ob der
  Papierkorb-Lauf arbeitet (Störfall 3) → erst danach vergrößern.
- **Vorbei, wenn:** der Anteil unter 85 % sinkt **und** ein Upload wieder
  gelingt. Die Zahl allein sagt nichts über die Schreibrechte im
  Ablageverzeichnis.

### Störfall 3 — ein Aufräumlauf bleibt aus

- **Symptom:** „zuletzt erfolgreich" steht über 26 Stunden zurück oder das
  Ergebnis ist „gescheitert (…)". ⚠️ **Darüber laufen die Löschfristen** —
  Papierkorb und Entwürfe 30 Tage, `mail_log` 90, KI-Freitext 30,
  unbeanspruchte Anlage 24 Stunden.
- **Prüfung:** die Fehlerklasse in der Tabelle. Datenbanknah
  (`PrismaClient…`)? Dann
  `curl -s -o /dev/null -w '%{http_code}' https://<basis>/api/health/ready` —
  bei 503 weiter bei Störfall 4.
- **Behebung:** `docker compose -f docker-compose.prod.yml restart api`. Das
  armiert alle Läufe neu und stößt sie sofort an; sie laufen beim Start **und**
  im Intervall.
- **Vorbei, wenn:** „zuletzt **erfolgreich**" auf wenige Minuten springt.
  „Zuletzt gelaufen" allein genügt nicht.

### Störfall 4 — die Datenbank ist weg

*Gemessen: `apps/api/test/incidents/database-gone.spec.ts`.*

- **Symptom:** `/api/health/ready` antwortet **503**, `/api/health` weiterhin
  200. Die Oberfläche wird ausgeliefert, jede Aktion darin scheitert.
  ⚠️ **Die Ansicht *Überwachung* ist genau jetzt nicht erreichbar** — ihre
  Zahlen kommen aus derselben Datenbank, und wer nicht angemeldet ist, kommt
  nicht einmal bis zur Anmeldung. Dafür gibt es den äußeren Beobachter.
- **Prüfung:** `docker compose -f docker-compose.prod.yml ps` und
  `… logs db`.
- **Behebung:** kommt die Datenbank nicht zurück, ist es der
  [Wiederherstellungsfall](#wiederherstellung). Der API-Container wird bewusst
  **nicht** neu gestartet — ein gesunder Prozess ohne Datenbank repariert sich
  dadurch nicht.
- **Vorbei, wenn:** `/api/health/ready` wieder 200 antwortet, ohne dass jemand
  die API angefasst hat. Danach ein Blick auf die Warteschlange: währenddessen
  ist nichts hinausgegangen.

### Störfall 5 — der KI-Anbieter antwortet nicht

*Gemessen: `apps/api/test/incidents/ai-provider-down.spec.ts`.*

- **Symptom:** die Fehlerquote steigt, über 25 % kommt der Alarm. Bearbeiter
  bekommen eine benannte Absage statt einer Fehlerseite; **die übrige Anwendung
  ist unberührt** — Ausfüllen, Export, Anmeldung, Bereitschaftsroute.
- **Was es kostet:** jeder Versuch zählt gegen das Monatskontingent der
  Organisation, auch der gescheiterte.
- **Behebung:** nichts Eiliges. Hält es an, in den systemweiten Einstellungen
  die KI abschalten — der Menüeintrag verschwindet, die Route antwortet 404.
- **Vorbei, wenn:** ein Entwurf wieder gelingt. ⚠️ **Nicht an der Fehlerquote
  ablesen** — sie läuft über den Kalendermonat und bleibt tagelang rot.

### Störfall 6 — die SSO-Anmeldung schlägt fehl

Der Browser bekommt nie einen Grund (ADR-0012); der Grund steht im Protokoll:

```bash
docker compose -f docker-compose.prod.yml logs api | grep -E '"context":"Oidc'
```

Die `?sso=`-Codes: `angemeldet` · `abgelehnt` (bestätigt, aber hier kein
Zugang) · `ohne-Organisation` (Konto ohne lebende Mitgliedschaft) ·
`fehlgeschlagen` (alles andere — sagt für sich genommen nichts).

| Meldung | Ursache |
|---|---|
| `issuer-missing`, `client-id-missing`, `scope-openid-missing` | Die Konfiguration der Organisation ist unvollständig — der Knopf erscheint gar nicht |
| `issuer-refused-by-allow-list` | `OIDC_ISSUER_ALLOWLIST` kennt diesen Host nicht |
| `client secret cannot be opened` | Secret mit einem anderen `SECRET_BOX_KEY` versiegelt — neu eintragen |
| `callback without a usable transaction cookie` mit `__Host-`-Präfix | Die Installation läuft über plain http, das Cookie verlangt TLS |
| `invalid_client` | Client-Secret stimmt nicht überein — oder der Anbieter erwartet `client_secret_basic`; diese Anwendung spricht `client_secret_post` |
| `invalid_grant` | Code verbraucht — oder die Redirect-URI ist beim Anbieter anders registriert |
| `no account carries this address` | Person unter genau dieser Adresse als SSO-Konto anlegen |
| `the address belongs to a local account with a password` | Kein Anbieter erreicht je ein lokales Konto |

Die Naht ist `apps/api/src/auth/oidc/oidc-diagnostics.ts`; dort steht auch,
warum keine Tokens, Adressen und Anbietertexte im Protokoll landen.

## Betroffenenanfrage nach DSGVO

Teilnehmer haben **kein Konto**. „Alle Daten zu Person X" ist deshalb keine
Abfrage, sondern ein Weg über die Organisation und über **jedes** Formular
einzeln; die erste Rückfrage lautet: *auf welchem Formular, und wann ungefähr?*

**1. Auskunft:** Formular → *Antworten* → Suchfeld mit Name oder Adresse →
Zeile öffnen → **Exportieren** (CSV, Excel, HTML). Der Export folgt der Sicht.
⚠️ **Vor dem Versand hineinsehen** — eine zu weite Suche oder eine alte
Spaltenwahl macht daraus die Antworten anderer Teilnehmer.

**2. Löschung:** in der Detailansicht löschen (→ Papierkorb der Organisation),
dann im **Papierkorb** „✕ Endgültig löschen". ⚠️ Erst der zweite Schritt ist
die Löschung; er ist physisch und unwiderruflich.

**3. Entwürfe.** Ein zwischengespeicherter Entwurf ist für Bearbeiter **nicht
sichtbar** und steht in keiner Auskunft. Er verfällt nach 30 Tagen oder mit der
Frist des Formulars; die ausfüllende Person kann ihn über „Entwurf verwerfen"
selbst löschen. Wird sofortige Löschung verlangt, führt der Weg über die
Datenbank:

```bash
docker compose -f docker-compose.prod.yml exec -T db psql -U formsache -d formsache \
  -c "select id, created_at, expires_at from response_draft where form_id = '<uuid>'"
docker compose -f docker-compose.prod.yml exec -T db psql -U formsache -d formsache \
  -c "delete from response_draft where id = '<uuid>'"
```

**4. Die Grenze, die man aussprechen muss.** Eine versendete Mail liegt im
Postfach ihres Empfängers und ist nicht zurückholbar. Das endgültige Löschen
**leert** im Versandprotokoll die Spalten, die eine Person nennen, und lässt die
Zeile als Betriebsspur stehen (`apps/api/src/mail-log/mail-log-erasure.ts`).

## Die KI einschalten

Ohne Konfiguration ist die Funktion **abwesend**: kein Menüeintrag, die Route
antwortet 404. Was vorher vorliegen muss — AV-Vertrag nach Art. 28 DSGVO an
erster Stelle — steht in [`10-datenschutz.md`](10-datenschutz.md) §4.

| Handgriff | Ergebnis |
|---|---|
| *Systemverwaltung → KI*: Anbieter, Modell, Region und Schlüssel eintragen | Die Seite meldet den Schlüssel als hinterlegt; der Wert kommt nie wieder heraus |
| Neu laden | Der Menüeintrag „✦ KI-Formular" ist da |
| Kontingent je Organisation setzen (*Systemverwaltung → Organisationen*) | „Verbrauch und Rest"; **`0` ist der Aus-Schalter für diese Organisation** |

⚠️ **Drei Schichten, und jede kann nur wegnehmen:** kann die Installation
(*Systemverwaltung → KI*)? · darf die Organisation (Kontingent, nur
Superadmin)? · will die Organisation (*Organisations-Verwaltung → KI*: erben, an,
aus)? In dieser Reihenfolge nachsehen, wenn „bei uns fehlt der Menüeintrag"
gemeldet wird. Ab dem Einschalten kostet jeder Versuch Geld — auch
der gescheiterte; das Kontingent ist die einzige Obergrenze.
