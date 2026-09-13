# 9. CI prüft jeden Push, GitVersion setzt die Version, zwei schlanke Images tragen sie

- **Status:** accepted
- **Date:** 2026-07-27

## Context

Drei Dinge hängen hier zusammen:
eine Pipeline, die jeden Commit prüft und bei Rot blockiert; eine Version, die
aus der Git-Historie kommt und in Image-Tag **und** `GET /api/health` steht;
und Images, die man betreiben kann — mehrstufig, schlank, non-root.

Zusammen hängt das, weil jedes Stück am nächsten hängt: die Version entsteht in
der Pipeline, das Image bekommt sie beim Bauen, und der Nachweis „Image-Tag =
`/api/health`" ist nur zu führen, wenn die Pipeline das gebaute Image auch
startet. Eine YAML-Datei allein belegt nichts — die `devops`-Regel dieses Repos
verlangt einen echten grünen Lauf.

Drei Randbedingungen ergaben sich bereits zuvor:

- **Der Testcontainers-Weg aus [ADR-0008](0008-test-database-provider.md) war
  nie gelaufen.** Die Agent-Umgebung hat keinen Docker-Daemon; belegt war immer
  nur der externe Ersatzweg. Das ADR erklärt Testcontainers zum Standardweg —
  ein Standardweg, den nichts ausführt, ist eine Behauptung.
- **`NODE_ENV` ist Pflichtvariable und entscheidet das Session-Cookie**
  (`Secure` und Name). Ein Image, das `production` fest einbrennt, ist lokal
  über http unbenutzbar; eines ohne jeden Wert startet gar nicht — das ist
  Absicht.
- **Das Anmelde-Rate-Limit zählt pro `req.ip`.** Sobald ein Reverse-Proxy davor
  steht, ist das für jeden Nutzer derselbe Wert. `login-rate-limit.ts` hat
  diesen Punkt ausdrücklich hierher verwiesen.

## Decision

### Eine Pipeline, ausgelöst von `push` auf allen Branches

`.github/workflows/ci.yml`, Jobs geschnitten nach Fehlerort: `version`,
`quality` (Matrix aus `lint`, `format:check`, `typecheck`), `docs`, `build`,
`test`, `e2e`, `stack`. Der rote Job **ist** die Diagnose.

Bewusst **kein** zusätzlicher `pull_request`-Trigger. Beide Ereignisse liefen
sonst für denselben Commit; der zweite Lauf verdoppelt entweder den ersten oder
bricht ihn — mit `cancel-in-progress` — ab, und ein abgebrochener Lauf ist als
Pflicht-Check wertlos. Check-Runs hängen an der Commit-SHA, deshalb sieht ein
Pull Request den Lauf des Pushes ohnehin.

Zwei Jobs machen mehr als das Offensichtliche:

- **`test` erzwingt `TEST_DATABASE_STRATEGY=testcontainers`.** Damit ist der
  Standardweg aus ADR-0008 zum ersten Mal wirklich gelaufen, und ein fehlender
  Daemon macht den Lauf rot statt still auszuweichen.
- **`stack` baut beide Images, startet den Compose-Stack und fährt ihn ab.**
  Version aus `/api/health` gegen den Image-Tag, `id -u` je Image, eine
  Anmeldung des Seed-Admins durch den Frontdoor. Damit ist das
  gemessen und nicht behauptet.

### GitVersion, konfiguriert auf Conventional Commits

`GitVersion.yml` mit `workflow: GitHubFlow/v1` (kurzlebige Branches auf `main`,
kein `develop`) und drei Bump-Regexen für `feat:`/`fix:`/`!:`. Ohne diese drei
sucht GitVersion nach seinen eigenen `+semver:`-Markern, und der Commit-Typ aus
`CONTRIBUTING.md` wäre Dekoration.

Die `feature`-Regex ist erweitert (`feat|fix|chore|claude`). Ein Branch, der zu
keiner Konfiguration passt, lässt GitVersion scheitern — aus einem Grund, der
mit der Änderung nichts zu tun hat.

### Zwei Images, drei bzw. zwei Stufen

- **API:** `deps` → `build` → `runtime`, plus eine Stufe `migrate`. Der
  Laufzeit-Baum entsteht mit `pnpm deploy --prod`, läuft als `node` (uid 1000)
  und bekommt `APP_VERSION` als Build-Argument.
- **Web:** Vite-Bundle hinter `nginxinc/nginx-unprivileged` (uid 101, Port
  8080). Dieses nginx ist der **Frontdoor**: es liefert die App aus und reicht
  `/api` unverändert weiter — Browser und API unter *einer* Herkunft, wie es
  das Session-Cookie verlangt.

`NODE_ENV` wird **nicht** ins Image gebrannt (siehe Consequences).

### `TRUST_PROXY_HOPS` schließt den Punkt aus `login-rate-limit.ts`

Neue Umgebungsvariable, Vorgabe **0** — `X-Forwarded-For` wird ignoriert. Der
Compose-Stack setzt `1` für seinen einen Frontdoor, und der *ersetzt* den
Header, statt anzuhängen. Express zählt vertraute Sprünge von rechts, damit
landet eine vorangestellte Wunschadresse dort, wo sie niemand liest.

## Consequences

**Gut:**

- Jeder Push wird geprüft, und der rote Job benennt die Stelle.
- Der Testcontainers-Weg ist belegt statt vorgesehen.
- `pnpm deploy --prod` erzeugt einen Baum ohne Dev-Abhängigkeiten; die
  Migration hat ihr eigenes, einmalig laufendes Image, und die Anwendung
  migriert nicht beim Start — was sich mit mehr als einer Instanz selbst ins
  Gehege käme.
- Der Nachweis „Version im Tag = Version in `/api/health`" ist Teil des Laufs.

**Preis und Fallstricke:**

- **`prisma generate` muss nach `pnpm deploy` erneut laufen.** Der generierte
  Client landet *im* `@prisma/client`-Paket des Baums, in dem er erzeugt wurde;
  `pnpm deploy` baut einen neuen Baum, und die Anwendung stirbt beim Start mit
  `Cannot find module '.prisma/client/default'`. Gemessen, bevor die Zeile im
  Dockerfile stand.
- **Der Laufzeit-Baum ist mit ~350 MB größer als „schlank" vermuten lässt.**
  `@prisma/client` deklariert `prisma` als optionalen Peer, den pnpm mit
  auflöst; damit kommen CLI, Studio und pglite mit. Von Hand aus dem Store zu
  löschen wäre eine Kürzung, die kein Test deckt — deshalb bleibt sie aus und
  steht stattdessen hier.
- **`NODE_ENV` bleibt Pflicht auch für den Container.** Wer das Image ohne die
  Variable startet, bekommt einen Startfehler. Das ist der Preis dafür, dass
  eine Produktivinstallation ihr Session-Cookie nicht versehentlich ungeschützt
  ausliefert.
- **`TRUST_PROXY_HOPS` ist eine Zahl, die zur Topologie passen muss.** Zu hoch
  gesetzt liest die API Einträge, die kein eigener Proxy geschrieben hat. Ein
  TLS-Terminator vor dem `web`-Dienst ist ein weiterer Sprung.
- **Der Frontdoor löst `api` beim Start auf.** nginx startet nicht, wenn der
  Name nicht auflösbar ist; deshalb wartet der Dienst auf eine gesunde API.

## Alternatives considered

- **Version aus `package.json` oder aus dem Git-Tag von Hand.** Verworfen:
  die Spezifikation nennt GitVersion, und eine handgepflegte Version ist genau die,
  die beim Release vergessen wird.
- **Migration im Start der API (`migrate deploy && node main.js`).** Bequem,
  aber sie verlangt die Prisma-CLI im Laufzeit-Image und läuft bei mehreren
  Instanzen mehrfach gleichzeitig.
- **Stock-`nginx` statt der unprivilegierten Variante.** Dessen Master-Prozess
  bleibt uid 0, um Port 80 zu binden — genau der Fall, den ein non-root-Image ausschließen soll.
- **Alles in einem CI-Job.** Schneller (ein Install statt sechs), aber der rote
  Lauf sagt dann nur „irgendwas". Der Schnitt in einzelne Jobs ist ausdrücklich verlangt.

## References

- [ADR-0005](0005-auth-sessions-oidc.md) (Session-Cookie, CSRF) ·
  [ADR-0006](0006-pnpm-workspaces.md) (pnpm, Corepack) ·
  [ADR-0008](0008-test-database-provider.md) (Test-Datenbanken)
- [`docs/kb/04-build-run.md`](../kb/04-build-run.md) (Anleitung und
  Fallstricke)

## Der gefahrene Jobschnitt

Ein Schnitt in neun Jobs kostete an einem reinen Doku-Lauf 19 abgerechnete
Minuten (GitHub rundet je Job auf volle Minuten auf), obwohl `version`, `docs`
und `build` zusammen unter einer Minute Arbeit hatten. `quality` (`lint`,
`format:check`, `typecheck`), `docs` und `build` sind deshalb **Schritte** eines
einzigen `quality`-Jobs; `version` ist kein eigener Job, sondern ein Schritt in
`stack` (seinem einzigen Verbraucher). Die unter „Alles in einem CI-Job"
verworfene Alternative trifft auf `quality` also zu — mit der dort genannten
Einschränkung gelöst, nicht ignoriert: jeder Schritt behält seinen Namen, und
`if: ${{ !cancelled() }}` auf jedem Schritt nach dem ersten hält die Garantie
„ein Fehler versteckt den nächsten nicht" ohne eigene Jobs aufrecht. `test`,
`e2e` und `stack` bleiben eigene Jobs — sie brauchen unterschiedliche
Laufzeitumgebungen (Datenbank-Service, Browser, Docker-in-Docker), die sich
nicht ohne Konflikt in einen Job packen lassen.

Details: `.github/workflows/ci.yml`.

## Die Images werden veröffentlicht — GHCR, öffentlich

Ein Bau, dessen Ergebnis die CI wegwirft, ist der fehlende Boden unter zwei
anderen Zusagen: ein Deployment, das selbst baut, hat kein vorheriges Artefakt —
der billige Rückfallweg existiert dann nicht, und die Produktionsgestalt
(`docker-compose.prod.yml`) könnte ihr `build:` nicht ablegen.

**Entschieden:**

- **Wohin: GHCR** (`ghcr.io/<owner>/formsache-api`, `-web` und `-migrate`). Die CI
  läuft ohnehin bei GitHub; es braucht **keine zusätzlichen Zugangsdaten** —
  der mitgelieferte `GITHUB_TOKEN` mit `packages: write` am Job genügt. Ein
  fremdes Register hieße: ein Geheimnis mehr, das jemand anlegen, drehen und
  beim Umzug wiederfinden muss, für einen Dienst, dessen einziger Vorteil
  gegenüber GHCR wäre, nicht GHCR zu sein. Hosting-agnostisch bleibt die
  Anwendung trotzdem: das Präfix ist die Variable `IMAGE_PREFIX`, und wer
  woanders hin will, ändert sie und den Push-Schritt.
- **Sichtbarkeit: öffentlich.** Der Zielserver braucht damit kein Lese-Token, `docker compose pull`
  funktioniert überall sofort — auch für eine zweite Installation oder eine Organisation, die selbst hosten will. Ein Lese-Token wäre ein Geheimnis auf jeder
  Maschine, die je diese Anwendung zieht, mit demselben Ablauf- und
  Drehproblem.
- **Drei Images, nicht zwei.** Vorgesehen sind `formsache-api` und `formsache-web`; der Stack hat ein drittes (`formsache-migrate`, eigenes Image, weil das Laufzeit-Image der
  API bewusst keine Prisma-CLI trägt). Ohne dessen Veröffentlichung könnte ein
  Server die Migrationen nicht fahren, ohne zu bauen — und „ein
  Produktionsserver baut nicht" ist genau diese Zusage.
- **Zwei unveränderliche Tags je Image: die GitVersion-Fassung und
  `sha-<commit>`.** Die Fassung ist die, über die Menschen reden; die SHA ist
  die, die eindeutig ist (zwei Läufe auf demselben Stand tragen dieselbe
  SemVer). Auf diesen beiden hängt der Weg zurück, und an ihnen ändert sich
  nichts.
- **Dazu drei bewegliche: `x`, `x.y` und `latest`** (Review-Runde 3 Nr. 1).
  Ursprünglich veröffentlichte dieser Job bewusst keine, mit dem Argument, ein
  bewegliches Tag sei die Einladung, ohne Fassung zu ziehen, und mache „zurück
  auf das vorherige Image" wieder zur Frage. Das Argument war zur Hälfte
  richtig und der Schluss daraus falsch:

  1. **Der Weg zurück wird nicht angefasst.** Er hängt an den unveränderlichen
     Tags. Dass `latest` weiterwandert, bewegt `1.4.2` nicht mit; wer eine
     Fassung festnagelt, hat sie weiterhin festgenagelt.
  2. **`docker-compose.prod.yml` liest seit jeher `${APP_VERSION:-latest}`** —
     und zeigte damit auf ein Tag, das es nicht gab. Wer dem dokumentierten Weg
     folgte, ohne `APP_VERSION` zu setzen, bekam einen Manifest-Fehler der
     Registry statt einer Warnung vor dem Nicht-Festnageln. Die verweigerte
     Marke erzwang die Fassungsbindung nicht, sie zerbrach die Vorgabe.

  `x` und `x.y` sind die Marken, an denen ein Betreiber entlang aktualisiert:
  „wir bleiben auf 1.4" ist eine Aussage über Verträglichkeit, die ein bloßes
  `latest` nicht ausdrücken und ein festgenageltes `1.4.2` nicht mitgehen kann.

  ⚠️ **Nur auf einer stabilen Fassung.** Eine Vorabfassung (GitVersions
  `PreReleaseTag` ist gesetzt) bewegt keine dieser drei Marken — sonst stünde
  hinter `latest` ein Stand, den niemand freigegeben hat. Belegt wird die
  Zuordnung im selben Lauf: der Schritt *Die rollenden Marken zeigen auf
  dieselbe Fassung* vergleicht die **Digests in der Registry**, nicht die
  lokalen Kopien.
- **Nur auf `main`**, als Bedingung am Job und nicht an den Schritten — ein
  übersehener Schritt ohne `if:` wäre sonst genau die Veröffentlichung, die
  niemand bestellt hat. Und erst, wenn `quality`, `test`, `e2e`, `stack` und
  `restore` grün sind: ein Image aus einem roten Lauf zieht später jemand,
  „weil es ja in der Registry liegt".

**Was daraus folgt, und es ist keine Nebenbedingung:**

⚠️ **Öffentlich heißt, dass jeder den fertigen Anwendungsstand ziehen kann.**
Damit hört „im Image steckt kein Geheimnis" auf, eine Absichtserklärung zu
sein. Der `publish`-Job fährt deshalb als letzten Schritt über den
**exportierten Dateibaum** jedes der drei Images und sucht nach einer `.env`,
nach Schlüsselmaterial und nach den **echten Werten dieses Laufs** (der
`SECRET_BOX_KEY`, den `setup-env` gerade erzeugt hat) — Punkt drei ist der
eigentliche Test, weil er auch eine Datei findet, die anders heißt. Eine
benannte, geschlossene Ausnahme: im `migrate`-Image steht
`apps/api/prisma/seed.ts` im
Quelltext, samt seiner dokumentierten Zod-Vorgaben; eine öffentliche Vorgabe in
öffentlichem Quelltext ist kein Geheimnis, und das Produktions-Overlay nimmt die
`SEED_*`-Variablen ohnehin weg.

**Einmalig von Hand, und deshalb hier notiert:** die Sichtbarkeit eines
GHCR-Pakets ist eine Einstellung am Paket, nicht am Workflow. Das erste
`docker push` legt es **privat** an; auf „public" stellt es der Betreiber
einmal in den Paket-Einstellungen. Bis dahin zieht kein fremder Server etwas,
und der Fehler sieht aus wie ein Netzwerkproblem.

**Wo der Versionsschritt misst.** „`/api/health` meldet die Version, mit der
das Image getaggt ist" wäre gegen den Tag des *lokal gebauten* Images ein Beleg
für den Bau und keine Aussage über das, was in der Registry liegt. Im
`publish`-Job wird deshalb das **gezogene** Image gemessen (die lokalen Kopien
werden vorher entfernt, sonst wäre der Zug eine Behauptung), und zwar in der
Produktionsgestalt. Im `stack`-Job bleibt der Schritt stehen: auf einem Zweig
wird nichts veröffentlicht, und ohne ihn hätte dort niemand mehr die Zusage.

**`TRUST_PROXY_HOPS` bleibt in beiden Gestalten `1`.** Der Abschnitt „Preis und
Fallstricke" oben nennt die Flanke: *„Ein TLS-Terminator vor dem `web`-Dienst
ist ein weiterer Sprung."* Eine Zahl je Topologie wäre die naheliegende
Antwort — und die falsche der beiden fiele im Betrieb nicht auf. Stattdessen
löst der nginx-Frontdoor den Aufrufer selbst auf (`set_real_ip_from` mit
`real_ip_recursive off`, gespeist aus `TRUSTED_PROXY_CIDR` bzw.
`PROD_TRUSTED_PROXY_CIDR`), sodass die API in beiden Gestalten genau einen
Sprung vor sich sieht. Der Nachweis im `stack`-Job misst dabei die **Zählung**
(zwei Aufrufer aus zwei Containern, zwei Eimer) und nicht den Header: zählte
die API die Adresse des TLS-Proxys, sperrten zehn Fehlversuche die ganze
Installation aus. Die Begründung im Langen steht am `api`-Dienst von
`docker-compose.prod.yml`.

Details: `.github/workflows/ci.yml` (`publish`), `docker-compose.prod.yml`,
`scripts/tests/compose-prod.test.sh`, `scripts/tests/publish-job.test.sh`.

## Das Release-Modell: jeder grüne Push auf `main` ist eine Fassung

Der Abschnitt oben beschreibt fünf Marken je Image, und drei davon hat der
erste `main`-Lauf **nicht** vergeben. Der Grund stand nicht im Job, sondern
daneben: es gab keinen Tag im Repository, also keine Versionsquelle. GitVersion
nahm `next-version: 1.0.0` als Boden und hängte im Modus `ContinuousDelivery`
die Commit-Zahl als Vorabfassungs-Nummer an.

```
FullSemVer        1.0.0-2
PreReleaseTag     "2"        ← nicht leer
VersionSourceSha  ""         ← keine Versionsquelle
```

Damit greift die Bedingung `[ -z "$prerelease" ]` im `publish`-Job nicht,
`APP_ROLLING_TAGS` bleibt leer, und `latest`, `x` und `x.y` entstehen nie —
während `docker-compose.prod.yml` dreimal auf `${APP_VERSION:-latest}`
zurückfällt. Das ist exakt der Zustand, den Review-Runde 3 Nr. 1 beheben
wollte: die Begründung stand im ADR, die Voraussetzung fehlte.

**Entschieden: `main` ist die Freigabe**, festgehalten als `mode:
ContinuousDeployment` für `main` in `GitVersion.yml`. Das Argument dafür ist
kein Vertrauen in die Sorgfalt der Beitragenden, sondern der `needs:`-Block:
`publish` läuft nur, wenn `quality`, `test`, `e2e`, `stack` und `restore` im
**selben Lauf** grün sind. Ein roter Stand auf `main` veröffentlicht nichts,
auch ohne Branch-Schutz. Und `docs/kb/09-betrieb.md` beschrieb dieses Modell
ohnehin bereits („`latest` — bewegt sich mit jedem Release").

⚠️ **Der Modus allein genügt nicht, und das ist der teuer gelernte Teil.**
GitVersion zählt vom letzten Tag, nicht je Commit. Gemessen, Tag `v1.0.0` und
fünf Commits darauf:

| Commit | ohne Rückschreiben | mit Rückschreiben |
|---|---|---|
| `fix: ein bugfix` | 1.0.1 | 1.0.1 |
| `chore(deps): regenerate third-party licence list` | 1.0.1 ← | 1.0.2 |
| `ci(deps): bump actions/setup-node` | 1.0.1 ← | 1.0.3 |
| `feat: neues feld` | 1.1.0 | 1.1.0 |
| `fix: noch einer` | 1.1.1 | 1.1.1 |

Drei verschiedene Stände unter einer Marke: `publish` hätte `1.0.1` dreimal mit
anderem Inhalt geschoben, und „`x.y.z` bewegt sich nie" — die Zeile, auf der
der Rückweg steht — wäre falsch geworden. Die beiden Commit-Typen sind nicht
erfunden, sie stehen so in der Historie; nur der `docs:`-Fall fängt sich selbst
ab, weil `ci-docs-only.sh` den ganzen Job überspringt.

**Deshalb schreibt der `publish`-Job die Fassung als Tag zurück**, als letzter
Schritt hinter allen vier Nachweisen. Ein Tag in der Historie behauptet, dass
diese Fassung im Register liegt; vor dem Geheimnis-Scan gesetzt wäre er eine
Behauptung, von der der nächste Commit weiterzählt.

**Was daraus folgt:**

- **`contents: write` am Job**, die zweite erhöhte Rechtevergabe dieser Datei
  und aus demselben Grund am Job statt oben in der Datei.
- **Keine Schleife**, zweifach abgesichert: der Trigger trägt
  `tags-ignore: ['**']`, und ein Push mit dem `GITHUB_TOKEN` startet ohnehin
  keinen Lauf. Dieselbe Eigenschaft zwingt
  [ADR-0031](0031-dependabot-lizenz-fixup.md) umgekehrt zu einem PAT — dort
  *sollen* Läufe starten.
- **Keine Kollision zweier Läufe.** `cancel-in-progress` ist auf `main` falsch,
  die Läufe stehen Schlange; der nächste checkt erst aus, wenn der Tag steht.
- **Kein initialer Tag von Hand.** Gemessen: ohne jeden Tag liefert
  `ContinuousDeployment` bereits `1.0.0` mit leerem `PreReleaseTag`. Der erste
  grüne `main`-Lauf veröffentlicht also `1.0.0` samt rollender Marken und setzt
  `v1.0.0` selbst.
- **Dependabot-Merges erzeugen Fassungen.** Gewollt: ein Bump *ist* ein anderes
  Artefakt, und über `x` bzw. `x.y` erreicht ein Sicherheitspatch den Betreiber
  ohne Zutun. Der Preis steht unten.
- **Das Restrisiko liegt zwischen den beiden Schritten**, und es ist benannt
  statt behauptet: scheitert der Tag-Push, nachdem die Images schon im Register
  liegen, bekommt der nächste Commit dieselbe Nummer — genau der Zustand, gegen
  den dieser Schritt steht. Der Lauf ist dann **rot**, und die Behebung ist der
  Wiederlauf des Jobs: er veröffentlicht dieselbe Fassung erneut (gleicher
  Inhalt, gleiche Digests) und setzt den Tag nach. Die umgekehrte Reihenfolge —
  erst taggen, dann veröffentlichen — tauscht dieses Risiko gegen das größere
  ein: ein Tag, hinter dem nichts liegt.
- **Ein `force-push` auf `main` bricht das Modell**, weil ein neuer Commit
  dieselbe Fassung errechnen kann, während der Tag noch auf dem alten steht.
  Der Schritt erkennt das (Tag zeigt auf eine andere SHA) und wird rot — das
  Image ist dann allerdings schon überschrieben. `CONTRIBUTING.md` verbietet
  den `force-push` auf `main` ohnehin; hier steht, was er zusätzlich kostet.

**Verworfen: der Tag als Freigabe von Hand** (`ContinuousDelivery` bleibt, ein
Mensch taggt). Das hätte den Vorteil, dass hinter `latest` nur ein angesehener
Stand steht — aber die Freigabe wäre ein zweiter, händischer Schritt, und
`tags-ignore: ['**']` macht ihn zusätzlich unbequem: ein nachgeschobener Tag
löst keinen Lauf aus, die Veröffentlichung müsste über `workflow_dispatch` von
Hand nachgezogen werden. Der Nutzen — ein menschliches Auge zwischen Grün und
Registry — wiegt das bei fünf unveränderlichen Marken und einem Rückweg über
`APP_VERSION` nicht auf.

⚠️ **Der offene Preis: `CHANGELOG.md`.** Einen Versionsabschnitt je
`fix(deps): bump …` schreibt niemand von Hand. Die Datei führt deshalb weiterhin
nur `[Unreleased]` als kuratierte Liste dessen, was der Rede wert ist — sie ist
damit kein Abbild der Fassungsfolge. Wer das ändern will, muss den Abschnitt im
`publish`-Job aus den Commits erzeugen; entschieden ist das hier **nicht**.

Details: `GitVersion.yml` (`branches.main`), `.github/workflows/ci.yml`
(`publish`, letzter Schritt), `scripts/tests/publish-job.test.sh`
(Abschnitt „Die Fassung wird als Tag zurückgeschrieben").
