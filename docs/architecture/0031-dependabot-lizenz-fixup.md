# 31. Lizenzliste nach Dependabot-PRs — ein privilegierter Workflow, eng gezäumt

- **Status:** accepted
- **Date:** 2026-09-13

## Context

`ci.yml`, Job `quality`, Schritt „Drittkomponenten-Liste gegen die Sperrdatei"
(`node tools/licences.ts --check`) vergleicht die eingecheckte
`apps/web/public/drittanbieter-lizenzen.json` gegen das, was die aktuelle
`pnpm-lock.yaml` erzeugen würde. Die Datei steht öffentlich auf `/licences` —
das ist der Grund, warum sie eingecheckt und nicht beim Bauen erzeugt wird
(`tools/licences.ts`, ausführlich dokumentiert).

Jede Versionsänderung einer Produktionsabhängigkeit ändert das erzeugte
Ergebnis. Dependabot (ADR-0018) hebt genau solche Versionen, wöchentlich
gebündelt — kann aber kein Repository-Skript ausführen und dessen Ergebnis
committen. Die Folge: praktisch **jeder** `npm`-Bündel-PR aus
`.github/dependabot.yml` kam rot aus `quality`, für eine Datei, die niemand
absichtlich angefasst hatte. ADR-0018 hat diese Reibung nicht vorhergesehen;
sie zeigte sich erst, als der erste Bündel-PR nach der Einführung der
Lizenzseite lief.

Drei Wege standen zur Wahl: ein Helferskript, das ein Mensch von Hand
anstößt; den `--check`-Schritt für Dependabot-PRs abschalten; oder ihn
automatisch grün machen, ohne dass jemand eingreifen muss. Die ersten beiden
verworfen — ein Helferskript verlangt weiterhin, dass sich jemand daran
erinnert, und ein abgeschalteter Check ist ein Check, der genau dann nichts
mehr prüft, wenn eine Abhängigkeit sich wirklich bewegt hat.

## Decision

### 1. Ein eigener Workflow, ausgelöst von `pull_request_target`

`.github/workflows/dependabot-licences.yml` regeneriert die Lizenzliste auf
dem Branch des PRs selbst und pusht sie zurück, wenn sie sich geändert hat.

**Warum `pull_request_target` und nicht `pull_request`.** GitHub gibt dem
`GITHUB_TOKEN` bei `pull_request`-Läufen, deren Akteur `dependabot[bot]` ist,
grundsätzlich nur Lesezugriff — unabhängig von der `permissions:`-Angabe im
Workflow
([„Restrictions when Dependabot triggers events"](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions),
geprüft am 2026-09-13). Diese Einschränkung besteht ausdrücklich, um genau
das zu verhindern, was dieser Workflow tun soll — mit dem Standard-Token
zurückschreiben. `pull_request_target` ist von dieser Einschränkung
ausgenommen; ohne diesen Wechsel könnte der Workflow gar nicht pushen.

### 2. Das „Pwn-Request"-Risiko, benannt statt verschwiegen

`pull_request_target` läuft mit dem Kontext des Basis-Repositorys — ein
Auschecken und Ausführen von Code aus dem PR selbst ist darin das
Lehrbuchbeispiel, mit dem ein PR-Autor Geheimnisse oder Schreibzugriff
erbeutet
([„Keeping your GitHub Actions and workflows secure: Preventing pwn
requests"](https://docs.github.com/en/actions/security-for-github-actions/security-guides/keeping-your-github-actions-and-workflows-secure-preventing-pwn-requests)).
Dieser Workflow tut genau das — er checkt den PR-Kopf aus und installiert
Abhängigkeiten daraus —, und drei Maßnahmen zusammen tragen die
Absicherung, keine für sich allein:

1. **Akteur *und* Herkunft am Job**, beide Bedingungen zugleich:
   `github.actor == 'dependabot[bot]'` **und**
   `github.event.pull_request.head.repo.full_name == github.repository`.
   `github.actor` lässt sich von einem gewöhnlichen Mitwirkenden nicht
   fälschen; die zweite Hälfte schließt einen Fork von vornherein aus —
   Dependabots eigene Branches liegen stets in diesem Repository, nie in
   einem Fork.
2. **`--ignore-scripts` beim Installieren.** Ein Paket, das Dependabot
   gerade angehoben hat, darf sein Postinstall-Skript nicht ausführen, bevor
   ein Mensch den PR gesehen hat. Genau das kann die bestehende
   Verbund-Aktion `.github/actions/setup-workspace` nicht — sie kennt kein
   `--ignore-scripts` —, weshalb der neue Workflow sie **nicht**
   wiederverwendet, sondern Node, Corepack und `pnpm install
   --frozen-lockfile --ignore-scripts` einzeln aufsetzt.
3. **Minimal zugeschnittene Rechte, am Job und nicht an der Datei.**
   `contents: write` steht nur auf `regenerate-licences`; jeder andere Job
   dieses Repositorys bliebe bei `contents: read`, falls es je einen zweiten
   gäbe — das Vorbild ist `ci.yml`s `publish`-Job mit `packages: write`.

Dependabots Branches liegen im selben Repository, nie in einem Fork — der
eigene Pwn-Request-Schutz von `actions/checkout` (der das Holen eines
**Fork**-PR-Kopfes unter `pull_request_target` verweigert) greift hier also
gar nicht erst. Getragen wird die Absicherung dieses Workflows von den drei
Maßnahmen oben, nicht von diesem Schutz.

### 3. Der Rückschreib-Push braucht einen PAT, kein `GITHUB_TOKEN`

Ein Push, der mit `GITHUB_TOKEN` erfolgt, löst laut GitHub-Dokumentation
**keine** neuen Workflow-Läufe aus
([„Triggering a workflow from a
workflow"](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow)).
Ohne eine andere Identität liefen `test`, `e2e`, `stack` und `restore` aus
`ci.yml` niemals gegen den frisch gefixten Commit — ein Pflicht-Check bliebe
auf dem alten, roten Stand hängen, obwohl die Ursache längst behoben ist.

Deshalb verwendet der Workflow `secrets.DEPENDABOT_FIXUP_TOKEN`, sowohl beim
`actions/checkout` (`with: token:`) als auch für den nachfolgenden `git
push`. Das Secret ist ein **Fine-grained Personal Access Token**, beschränkt
auf `contents: write` an genau diesem Repository — keine weiteren Rechte,
kein Ablaufdatum von „nie", sondern eine sinnvolle Frist (ein Jahr) mit einer
Erinnerung zur Erneuerung.

**Dieses Secret existiert nicht von selbst — es ist einmalig von Hand
anzulegen:**

1. Ein Fine-grained PAT erzeugen (unter dem Konto, das für automatisierte
   Commits stehen soll), Repository-Zugriff **nur** auf `formsache`,
   Berechtigung **nur** `Contents: Read and write`, Ablauf in einem Jahr mit
   Kalendererinnerung zur Erneuerung.
2. Als Repository-Secret unter dem Namen `DEPENDABOT_FIXUP_TOKEN` hinterlegen
   (Repository-Einstellungen → Secrets and variables → Actions).

Bis dahin läuft der Workflow ohne Wirkung: der Checkout- oder Push-Schritt
scheitert, `quality` bleibt für Dependabot-PRs rot wie zuvor — kein
schlechterer Zustand als vor dieser Entscheidung, nur kein besserer.

### 4. Committer-Identität und Commit-Nachricht

`github-actions[bot]` mit der bekannten `noreply`-Adresse
(`41898282+github-actions[bot]@users.noreply.github.com`), Commit-Nachricht
`chore(deps): regenerate third-party licence list` im Stil der
Dependabot-Präfixe aus ADR-0018. Kein `Co-Authored-By` — diese Zeile ist in
diesem Repository für Claude-Commits reserviert, hier unpassend.

## Consequences

**Gut:**

- Ein Dependabot-Bündel-PR ist ab jetzt wieder das, was ADR-0018 verspricht:
  ein Vorgang, den jemand liest und mergt — nicht einer, der erst manuell
  nachgezogen werden muss, bevor `quality` grün wird.
- Die Absicherung gegen einen Pwn-Request steht dreifach und ist an dieser
  Stelle benannt, nicht nur im Workflow-Kommentar.
- Ein Push mit dem PAT setzt die volle Pipeline erneut in Gang — der grüne
  Zustand, den ein Pflicht-Check sieht, gehört wirklich zum gefixten Commit.

**Preis und Grenzen — benannt:**

- **Ein PAT ist ein zusätzliches Geheimnis, das rotiert werden muss.** Läuft
  es ab, ohne erneuert zu werden, bricht der Push still — `quality` fällt für
  Dependabot-PRs auf den alten, manuellen Zustand zurück, ohne dass diese
  Entscheidung selbst etwas davon meldet. Die Kalendererinnerung aus Schritt
  3 ist die einzige Absicherung dagegen.
- **Der PAT trägt `contents: write` auf das ganze Repository, nicht nur auf
  die eine Datei.** Ein kompromittierter PAT könnte grundsätzlich jede Datei
  über einen Push ändern — begrenzt bleibt der Schaden dadurch, dass der
  Workflow selbst nur unter den beiden Bedingungen aus Abschnitt 2 überhaupt
  läuft, und dass GitHub-PATs sich jederzeit ohne Versionswechsel widerrufen
  lassen.
- **`--ignore-scripts` deckt nur diesen einen Workflow ab.** Der reguläre
  `ci.yml`-Lauf auf demselben PR (ausgelöst von `push`, da Dependabots
  Branches in diesem Repository liegen) installiert weiterhin ohne dieses
  Flag, wie jeder andere Lauf auch — das ist unverändert und liegt außerhalb
  dieser Entscheidung.

## Alternatives considered

- **Ein Helferskript, das ein Mensch von Hand ausführt.** Verworfen: es
  verlangt weiterhin, dass sich jemand an den Schritt erinnert — genau die
  Reibung, die diese Entscheidung beseitigen soll.
- **Den `--check`-Schritt für Dependabot-PRs abschalten.** Verworfen: die
  Lizenzliste ist öffentlich auf `/licences` und die eine Art Fehler, die
  diese Anwendung sonst sichtbar ausliefert (`tools/licences.ts`) — ein
  abgeschalteter Check ist ein Check, der ausgerechnet dann nichts mehr
  prüft, wenn sich eine Abhängigkeit tatsächlich bewegt hat.
- **`pull_request` statt `pull_request_target`.** Nicht möglich: der
  Standard-Token wäre für den Akteur `dependabot[bot]` nur lesend, und der
  Workflow könnte gar nicht zurückschreiben.

## References

- [ADR-0018](0018-abhaengigkeitspflege.md) (Dependabot, Präfixe, wöchentliche
  Bündelung) · [`tools/licences.ts`](../../tools/licences.ts) (was erzeugt
  wird und warum) · [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
  (der `quality`-Job, der `--check` ausführt, und der `publish`-Job als
  Vorbild für job-scoped Rechte)
- GitHub-Dokumentation, geprüft am 2026-09-13: [„Restrictions when Dependabot
  triggers
  events"](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions) ·
  [„Keeping your GitHub Actions and workflows secure: Preventing pwn
  requests"](https://docs.github.com/en/actions/security-for-github-actions/security-guides/keeping-your-github-actions-and-workflows-secure-preventing-pwn-requests) ·
  [„Triggering a workflow from a
  workflow"](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow)
