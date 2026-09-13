#!/usr/bin/env bash
#
# publish-job.test.sh — the shape of the `publish` job.
#
# ⚠️ **This checks no behavior.** It reads the `publish` block from
# `.github/workflows/ci.yml` and compares it with what is promised. In the
# marker language used here that is 📋, not 🧪 — whether it really publishes,
# whether the pulled image reports its version and whether no secret is in it,
# is evidenced only by a green run of the job on `main`.
#
# **What it is there for anyway.** Three of the four reproductions are
# otherwise **not runnable here**: they demand a push to `main`, and a
# change whose reproductions are only runnable after the merge has
# none. This file makes them mechanical:
#
#   * tag from the build argument instead of GitVersion  → section „zwei Tags"
#   * `main` condition removed                           → section „nur main"
#   * secret scan removed                                → section „Scan"
#
# The fourth (copying a `.env` into the image) is not runnable from here —
# it needs a build. It is described in the job itself.
#
# The build is that of `restore-drill.test.sh`: the **job block** is cut
# out, the file is not searched. A guard that finds `packages: write`
# somewhere in the file also finds the comment above it.
#
# Usage: scripts/tests/publish-job.test.sh
# Exit: 0 = the shape is right, 1 = not.
set -uo pipefail

# ⚠️ **No `grep` behind a pipe from `$job`** — everywhere below it says
# `grep … <<<"$job"`, and that is no mere formality.
#
# `set -o pipefail` stands one line higher, and `grep -q` exits at the **first**
# hit. The writing `printf` then gets SIGPIPE, reports
# „write error: Broken pipe", and `pipefail` makes its failure the status
# of the whole pipeline. The `if` then takes the `else` branch: **a hit is
# reported as a non-hit.** Whether it strikes depends on whether `grep` is done
# before the write call of the `printf` — so on the machine, not on the
# content.
#
# *Measured on 2026-08-18:* the run on `3892464` reported „✗ im Job läuft kein
# GitVersion — woher käme die Fassung?" together with the broken-pipe line, while
# `dotnet-gitversion` stood there unchanged. The same call was green on this
# machine. The file has warned at its tar section about exactly this
# trap all along and has fallen for it itself in 22 of its own places.
#
# A `<<<` has no pipe, hence also no SIGPIPE. The two remaining pipes
# feed `wc -l` and `awk` — both read to the end and cannot exit
# earlier at all.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/ci.yml"

failures=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() {
  printf '  \033[31m✗\033[0m %s\n' "$1"
  failures=$((failures + 1))
}

# The block of the `publish` job — from its line to the next job.
job="$(awk '
  /^  publish:$/ { inside = 1 }
  /^  [a-z-]+:$/ && !/^  publish:$/ { if (inside) exit }
  inside' "$WORKFLOW")"

if [ -z "$job" ]; then
  printf '\033[31mder publish-Job steht nicht in der ci.yml — dieser Test misst nichts.\033[0m\n'
  exit 1
fi
lines="$(printf '%s\n' "$job" | wc -l)"
printf '\n== Der publish-Job steht da (%s Zeilen) ==\n' "$lines"
ok 'Block gefunden'

printf '\n== Nur main veröffentlicht ==\n'
# ⚠️ The condition belongs on the **job**, not on the steps: a single
# step without `if:` would otherwise be the publication that nobody ordered.
if grep -qE "^    if: .*github\.ref == 'refs/heads/main'" <<<"$job"; then
  ok 'der Job trägt die main-Bedingung'
else
  bad 'der Job hat keine main-Bedingung — jeder Zweig würde veröffentlichen'
fi

printf '\n== Fünf Marken, und die Fassung kommt aus dem Lauf ==\n'
# The version comes from GitVersion and not from a default. `0.0.0-dev` is
# the default value of the compose file; if it stood here, every image would carry it.
if grep -qF 'dotnet-gitversion' <<<"$job"; then
  ok 'die Fassung kommt aus GitVersion'
else
  bad 'im Job läuft kein GitVersion — woher käme die Fassung?'
fi
if grep -qF '0.0.0-dev' <<<"$job"; then
  bad 'der Job nennt den Vorgabewert 0.0.0-dev'
else
  ok 'kein 0.0.0-dev im Job'
fi
push_line="$(grep -n 'docker push' <<<"$job" | head -n 1 | cut -d: -f1)"
if [ -n "$push_line" ]; then
  ok 'es wird wirklich gepusht'
else
  bad 'der Job pusht nichts'
fi
for tag in '"${APP_VERSION}"' '"sha-${GITHUB_SHA}"'; do
  if grep -qF "$tag" <<<"$job"; then
    ok "getaggt mit $tag"
  else
    bad "kein Tag $tag — Fassung **und** Commit-SHA sind verlangt"
  fi
done
# **Die drei beweglichen Marken** (Review-Runde 3 Nr. 1). Sie standen hier
# einmal als Verbot — „ein bewegliches Tag nimmt dem Rückweg den Sinn" —, und
# der Schluss war falsch: der Rückweg hängt an den beiden unveränderlichen
# Marken darüber, die unangetastet bleiben, und `docker-compose.prod.yml` las
# ohnehin `${APP_VERSION:-latest}`, zeigte also auf ein Tag, das es nicht gab.
# Die Begründung in voller Länge steht in ADR-0009.
if grep -qF 'APP_ROLLING_TAGS' <<<"$job"; then
  ok 'die rollenden Marken werden vergeben'
else
  bad 'keine rollenden Marken — docker-compose.prod.yml zeigt auf latest'
fi
for part in '$major' '$major.$minor' 'latest'; do
  if grep -qF "APP_ROLLING_TAGS=$part" <<<"$job" ||
    grep -qF " $part" <<<"$(grep 'APP_ROLLING_TAGS=' <<<"$job")"; then
    ok "die Liste enthält $part"
  else
    bad "die Liste enthält $part nicht"
  fi
done
# ⚠️ **Und sie bewegen sich nur auf einer stabilen Fassung.** Ohne diese
# Bedingung stünde hinter `latest` irgendwann eine Vorabfassung, die niemand
# freigegeben hat — genau der Zustand, gegen den das alte Verbot argumentierte
# und der als einziger davon übrig bleibt.
if grep -qF 'PreReleaseTag' <<<"$job"; then
  ok 'eine Vorabfassung bewegt keine Marke'
else
  bad 'nichts hält Vorabfassungen von latest fern'
fi
# Und die Zuordnung wird belegt, nicht behauptet: die Digests in der Registry
# werden verglichen, nicht die lokalen Kopien.
if grep -qF 'imagetools inspect' <<<"$job"; then
  ok 'die rollenden Marken werden gegen die Registry geprüft'
else
  bad 'nichts prüft, worauf die rollenden Marken zeigen'
fi

printf '\n== Der Versionsschritt steht HINTER dem Veröffentlichen ==\n'
# The order is the promise: previously the step compared the tag of the
# *locally built* image. What is to be measured is the **pulled** one.
# ⚠️ **Gemessen wird an den Schritt-Namen, nicht am ersten Vorkommen im
# Fließtext.** Bis Review-Runde 3 stand hier `grep -n 'compose .*pull'`, und
# das fand als Erstes die *Begründung* eines Kommentars weiter oben. Der
# Wächter war damit grün, weil ein Kommentar in der richtigen Reihenfolge
# stand — und wurde rot, als dieser Kommentar wegfiel, obwohl die Schritte
# unverändert richtig standen. Ein `- name:` ist ein Schritt und kein Satz.
# Gemessen wird die Zeile, die wirklich misst — `reported=$(curl … /api/health)`
# —, und nicht der Name des Schrittes: der Zug steht **innerhalb** desselben
# Schrittes, ein Vergleich gegen den Schritt-Namen wäre also immer falsch
# herum.
measure_line="$(grep -n 'reported=.*api/health' <<<"$job" | head -n 1 | cut -d: -f1)"
pull_line="$(grep -n '^ *docker compose .*pull$' <<<"$job" | head -n 1 | cut -d: -f1)"
if [ -n "$measure_line" ] && [ -n "$push_line" ] && [ "$push_line" -lt "$measure_line" ]; then
  ok 'erst veröffentlichen, dann die Fassung messen'
else
  bad 'der Versionsschritt steht nicht hinter dem Veröffentlichen'
fi
if [ -n "$pull_line" ] && [ -n "$measure_line" ] && [ "$pull_line" -lt "$measure_line" ]; then
  ok 'gemessen wird das gezogene Image, nicht das lokal gebaute'
else
  bad 'vor der Messung wird nichts gezogen — dann misst sie den lokalen Bau'
fi
if grep -qF 'docker image rm' <<<"$job"; then
  ok 'die lokalen Kopien werden vorher entfernt (sonst wäre der Zug eine Behauptung)'
else
  bad 'die lokal gebauten Images bleiben liegen — compose zöge dann nichts'
fi

printf '\n== Kein Geheimnis im Image: der Scan steht drin ==\n'
if grep -qF 'docker export' <<<"$job"; then
  ok 'der Scan fährt über den exportierten Dateibaum'
else
  bad 'kein docker export — der Scan prüft die Images nicht'
fi
for needle in 'SECRET_BOX_KEY' 'PRIVATE KEY' 'change-me-locally' '\.env'; do
  if grep -qE "$needle" <<<"$job"; then
    ok "gesucht wird nach: $needle"
  else
    bad "der Scan sucht nicht nach: $needle"
  fi
done
# **The separation of the two scan halves, since 2026-08-12.** The real
# values of this run (`$secret_box`, `$pg_password`) run over the *whole*
# stream; the generic patterns (PEM header, `change-me-locally`) leave out
# `node_modules`, because `dotenv`, `@mistralai/mistralai` and `ssh2` carry these
# character strings in documentation and constants and would otherwise make the
# step red on every run. Whoever extends the exception to the real values
# makes the scan lenient — exactly what these two lines stand against.
if grep -qE 'grep -aqF -- "\$secret_box" /tmp/image\.tar' <<<"$job"; then
  ok 'der SECRET_BOX_KEY wird über den ganzen Strom gesucht, ohne Ausnahme'
else
  bad 'der SECRET_BOX_KEY wird nicht mehr über die ganze Datei gesucht'
fi
if grep -qE 'grep -aqF -- "\$pg_password" /tmp/image\.tar' <<<"$job"; then
  ok 'ein echtes POSTGRES_PASSWORD ebenso — die Ausnahme gilt nur dem Platzhalter'
else
  bad 'ein echtes POSTGRES_PASSWORD wird nicht scharf geprüft'
fi
if grep -qF -- "--exclude='*node_modules/*'" <<<"$job"; then
  ok 'die generischen Muster lassen die Bibliotheken aus (sonst: rot bei jedem Lauf)'
else
  bad 'kein --exclude für die generischen Muster — der Schritt wird an dotenv/ssh2 rot'
fi
# ⚠️⚠️ **No `grep -q` behind a `tar` pipe** (the heaviest finding of the
# review gate). Under `set -euo pipefail`, `grep -q` exits at the
# first hit, `tar` dies of SIGPIPE, `pipefail` makes the pipeline
# fail and the `if` condition **false**: the scan stays silent on a
# real hit. Reproduced with a 40 MB archive („VERPASST"). `grep -c`
# reads the stream to the end and does not have the problem.
if grep -qE 'tar -xOf[^|]*\|[[:space:]]*grep -[a-z]*q' <<<"$job"; then
  bad 'der Scan benutzt grep -q hinter einem tar-Rohr — ein echter Fund geht an SIGPIPE verloren'
else
  ok 'kein grep -q hinter einem tar-Rohr (SIGPIPE verschluckt sonst den Fund)'
fi
# And our own workspace packages stay in the stream: in the deploy tree
# `@formsache/shared` lies under `node_modules/`, and that is our code.
if grep -qF "node_modules/@formsache/" <<<"$job"; then
  ok 'die eigenen Pakete unter node_modules werden mitgeprüft'
else
  bad 'node_modules/@formsache/* wird mit ausgeschlossen — das ist unser eigener Code'
fi

# The scan has to touch **all** published images. One that only checks the
# web image is the scan that never saw the API image.
if grep -qE 'for image in api web migrate' <<<"$job"; then
  ok 'der Scan fährt über alle drei veröffentlichten Images'
else
  bad 'der Scan fährt nicht über alle drei Images'
fi

printf '\n== Die Fassung wird als Tag zurückgeschrieben ==\n'
# **Die zweite Hälfte des Release-Modells**, und ohne sie steht die Fassung
# still. `main` läuft im Modus `ContinuousDeployment` (GitVersion.yml), also
# ist jeder grün durchgelaufene Push eine stabile Fassung — GitVersion zählt
# dabei aber vom **letzten Tag** und nicht je Commit. Gemessen ohne den
# Rückschreibschritt: `fix:` → 1.0.1, das folgende `chore(deps):` → 1.0.1, das
# folgende `ci(deps):` → 1.0.1. Drei Stände unter einer Marke, und `x.y.z`
# wäre nicht mehr unveränderlich.
#
# *Reproduktion:* den Schritt entfernen → dieser Abschnitt wird rot.
# `tag -a` und nicht `git tag -a`: die Tagger-Identität steht als `-c`-Paar
# davor, das `git` also eine Zeile höher. Der erste Entwurf dieser Zeile suchte
# nach `git tag` und war rot, obwohl der Schritt richtig dastand.
if grep -qE '^ *tag -a "\$tag"' <<<"$job"; then
  ok 'der Job legt den Tag an'
else
  bad 'kein Tag — drei Commits bekämen dieselbe Fassung'
fi
if grep -qE 'git push origin "refs/tags/\$tag"' <<<"$job"; then
  ok 'und schiebt ihn zurück (sonst zählte der nächste Lauf wieder von vorn)'
else
  bad 'der Tag wird nicht gepusht — er stürbe mit dem Runner'
fi
# ⚠️ **Und er steht HINTER den Nachweisen.** Ein Tag behauptet, dass diese
# Fassung veröffentlicht ist; stünde er vor dem Geheimnis-Scan, trüge die
# Historie eine Zahl, zu der im Register nichts liegt — und der nächste Commit
# zählte von ihr weiter. Gemessen an der Zeile, die wirklich taggt.
tag_line="$(grep -n 'git push origin "refs/tags/' <<<"$job" | head -n 1 | cut -d: -f1)"
scan_line="$(grep -n 'docker export' <<<"$job" | head -n 1 | cut -d: -f1)"
if [ -n "$tag_line" ] && [ -n "$scan_line" ] && [ "$scan_line" -lt "$tag_line" ]; then
  ok 'erst die Nachweise, dann der Tag'
else
  bad 'der Tag wird vor dem Geheimnis-Scan geschrieben'
fi
# Ohne mitgegebene Zugangsdaten scheitert der Push — und die Vorgabe der
# Action ist nichts, worauf sich das verlassen sollte.
if grep -qE '^ *persist-credentials: true$' <<<"$job"; then
  ok 'der Checkout behält die Zugangsdaten (sonst scheitert der Push)'
else
  bad 'ohne persist-credentials kann der Tag-Push nicht authentifizieren'
fi
# **Der Doku-Lauf taggt nicht.** Er veröffentlicht auch nichts; ein Tag ohne
# Image wäre die Behauptung, die dieser Abschnitt gerade ausschließt.
if grep -A 2 'name: Die veröffentlichte Fassung als Tag' <<<"$job" |
  grep -qF "docs-only.outputs.docs_only != 'true'"; then
  ok 'ein reiner Doku-Push taggt nicht'
else
  bad 'der Doku-Push taggt — ein Tag ohne Image dahinter'
fi
# Und die andere Hälfte steht wirklich in GitVersion.yml: ohne
# `ContinuousDeployment` wäre jeder Commit auf `main` eine Vorabfassung, der
# Tag hieße `v1.0.1-3` und keine rollende Marke bewegte sich je.
if grep -A 2 -E '^  main:$' "$ROOT/GitVersion.yml" | grep -qF 'mode: ContinuousDeployment'; then
  ok 'main steht in GitVersion.yml auf ContinuousDeployment'
else
  bad 'main ist keine stabile Fassung — latest, x und x.y entstünden nie'
fi

printf '\n== Die Rechte sind so eng wie möglich ==\n'
if grep -qE '^      packages: write$' <<<"$job"; then
  ok 'packages: write steht am Job'
else
  bad 'der Job hat kein packages: write — das Pushen scheiterte'
fi
# `contents: write` ist die zweite erhöhte Rechtevergabe, und sie hat genau
# einen Grund: den Tag-Push oben. Sie steht ebenfalls am Job.
if grep -qE '^      contents: write$' <<<"$job"; then
  ok 'contents: write steht am Job (für den Tag)'
else
  bad 'der Job darf nicht schreiben — der Tag-Push scheiterte'
fi
# And the permission is **not** on the file: every other job gets by with
# `contents: read`.
# `-q` would cut off the output before the second search sees it — the
# first draft of this line was therefore always green.
if grep -A 3 '^permissions:' "$WORKFLOW" | grep -qE 'packages|contents: write'; then
  bad 'ein erhöhtes Recht steht global in der Datei'
else
  ok 'global bleibt es bei contents: read'
fi
# No additional secret: the shipped GITHUB_TOKEN suffices.
if grep -oE 'secrets\.[A-Z_]+' <<<"$job" | grep -qv 'secrets.GITHUB_TOKEN'; then
  bad 'der Job benutzt ein zusätzliches Geheimnis'
else
  ok 'nur der GITHUB_TOKEN, keine zusätzlichen Zugangsdaten'
fi

printf '\n== Ein Doku-Push veröffentlicht nicht (Review-Befund) ==\n'
# **Why this stands here.** `test`, `e2e`, `stack` and `restore` skip
# their steps on a pure docs push and still report green — intentional,
# and it saves minutes. `publish` read this green as "everything checked" and
# published an image for which **not a single test** had been run in this
# run. `needs:` alone does not protect against that: the preconditions are
# after all fulfilled.
if grep -qE '^      - id: docs-only$' <<<"$job"; then
  ok 'der Job fragt selbst, ob es ein Doku-Push war'
else
  bad 'kein docs-only-Schritt — ein Doku-Push veröffentlichte ein ungetestetes Image'
fi
# And **every** effective step hangs on it — exactly, not approximately.
#
# ⚠️ The first version compared `guarded >= total - 2` and stayed green in the
# counter-check: taking the condition away from one step fell within the
# tolerance. Therefore what is counted is **which** steps stand there without a
# condition, and exactly two are allowed: the checkout (without it there would be
# no script to ask) and the guard itself.
unguarded="$(printf '%s\n' "$job" | awk '
  # A step begins at "      - " and ends before the next one.
  /^      - / {
    if (step != "" && step !~ /docs_only != .true./) print first
    step = $0; first = $0; next
  }
  step != "" { step = step "\n" $0 }
  END { if (step != "" && step !~ /docs_only != .true./) print first }
')"
unguarded_count="$(printf '%s' "$unguarded" | grep -c . || true)"
if [ "$unguarded_count" -eq 2 ] \
  && printf '%s\n' "$unguarded" | grep -qF 'actions/checkout@v7' \
  && printf '%s\n' "$unguarded" | grep -qF 'id: docs-only'; then
  ok 'jeder wirksame Schritt hängt am Wächter (nur Checkout und der Wächter selbst nicht)'
else
  bad "Schritte ohne docs-only-Bedingung: $(printf '%s' "$unguarded" | tr '\n' ' ')"
fi

printf '\n== Veröffentlicht wird nur, was grün ist ==\n'
if grep -qE '^    needs: \[.*stack.*\]' <<<"$job"; then
  ok "der Job wartet auf die anderen ($(grep -oE 'needs: \[.*\]' <<<"$job"))"
else
  bad 'der Job hat kein needs — er veröffentlichte auch aus einem roten Lauf'
fi

printf '\n'
if [ "$failures" -eq 0 ]; then
  printf '\033[32mOK: die Gestalt des publish-Jobs stimmt.\033[0m\n'
  exit 0
fi
printf '\033[31m%d Abweichung(en).\033[0m\n' "$failures"
exit 1
