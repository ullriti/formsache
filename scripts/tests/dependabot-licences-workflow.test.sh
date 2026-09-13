#!/usr/bin/env bash
#
# dependabot-licences-workflow.test.sh — the shape of
# `.github/workflows/dependabot-licences.yml` (ADR-0031).
#
# ⚠️ **This checks no behaviour.** Like `publish-job.test.sh`, it reads the
# workflow file and compares it against what ADR-0031 promises — in the
# marker language used across this repository that is 📋, not 🧪. Whether the
# workflow really regenerates the licence list, really pushes back and really
# runs only for a same-repository Dependabot PR is something only a real
# Dependabot pull request on `main` can show. This file makes the *shape*
# mechanical instead, because the reproductions that matter here — a fork PR
# pretending to be Dependabot, an actor other than Dependabot, a missing
# `--ignore-scripts` — are exactly the ones nobody wants to try against the
# real workflow to find out.
#
# Usage: scripts/tests/dependabot-licences-workflow.test.sh
# Exit: 0 = the shape is right, 1 = not.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/dependabot-licences.yml"
SETUP_WORKSPACE="$ROOT/.github/actions/setup-workspace/action.yml"

# The workflow explains its own "must not"s in prose right next to the
# `run:`/`uses:` lines that keep the promise — a plain comment mentioning
# `setup-workspace` or `--check` to say why the workflow avoids them would
# otherwise trip the very guard meant to catch the opposite mistake. Comment
# lines (optionally indented, starting with `#`) are stripped before the two
# "must not appear in real steps" checks below; every other check reads the
# file as-is.
CODE="$(grep -vE '^\s*#' "$WORKFLOW")"

failures=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() {
  printf '  \033[31m✗\033[0m %s\n' "$1"
  failures=$((failures + 1))
}

if [ ! -f "$WORKFLOW" ]; then
  printf '\033[31mder Workflow steht nicht unter %s — dieser Test misst nichts.\033[0m\n' \
    "$WORKFLOW"
  exit 1
fi

printf '\n== Ausgelöst von pull_request_target, nicht von pull_request ==\n'
# The read-only GITHUB_TOKEN GitHub hands a `pull_request` run whose actor is
# dependabot[bot] is the whole reason this workflow exists in this shape —
# see ADR-0031, section 1.
if grep -qE '^  pull_request_target:' "$WORKFLOW"; then
  ok 'pull_request_target steht als Auslöser'
else
  bad 'kein pull_request_target — der Standard-Token wäre für Dependabot nur lesend'
fi
if grep -qE '^  pull_request:' "$WORKFLOW"; then
  bad 'pull_request steht daneben — genau das gäbe den lesenden Token zurück'
else
  ok 'kein zusätzlicher pull_request-Auslöser'
fi

printf '\n== Rechte: eng an der Datei, weiter nur am Job ==\n'
if grep -A 1 '^permissions:' "$WORKFLOW" | grep -qE '^  contents: read$'; then
  ok 'auf Dateiebene bleibt es bei contents: read'
else
  bad 'die Datei trägt nicht global contents: read'
fi
# The job's own `permissions:` block must add exactly `contents: write` and
# nothing else — no `pull-requests`, no `issues`, no `packages`. Two
# `permissions:` blocks exist in this file (file-level and job-level); the
# second is the one under test.
job_perms="$(awk '
  /^    permissions:$/ { inside = 1; next }
  inside && /^      [a-z-]+: / { print; next }
  inside { exit }
' "$WORKFLOW")"
if printf '%s\n' "$job_perms" | grep -qE '^      contents: write$'; then
  ok 'der Job trägt contents: write'
else
  bad 'der Job hat kein contents: write — der Push scheiterte'
fi
extra="$(printf '%s\n' "$job_perms" | grep -vE '^      contents: write$' | grep -c . || true)"
if [ "${extra:-0}" -eq 0 ]; then
  ok 'sonst kein weiteres Recht am Job'
else
  bad "am Job stehen weitere Rechte: $(printf '%s' "$job_perms" | tr '\n' ' ')"
fi

printf '\n== Der Job läuft nur für eine echte Dependabot-PR gegen dieses Repository ==\n'
# ⚠️ Both conditions, not just one — see ADR-0031 section 2. The actor check
# alone would trust `github.actor` in isolation (fine on its own, but the
# repository check catches the other half: a fork PR is excluded only by the
# second half).
if grep -qF "github.actor == 'dependabot[bot]'" <<<"$CODE"; then
  ok 'der Akteur wird geprüft'
else
  bad 'keine Prüfung auf dependabot[bot] — jeder PR-Autor bekäme den Token'
fi
if grep -qF 'head.repo.full_name == github.repository' <<<"$CODE"; then
  ok 'die Herkunft (kein Fork) wird geprüft'
else
  bad 'keine Fork-Prüfung — ein Fork-PR bekäme den Token, sofern der Akteur passt'
fi

printf '\n== Kein Postinstall-Skript vor einer menschlichen Prüfung ==\n'
if grep -qF -- '--ignore-scripts' <<<"$CODE"; then
  ok '--ignore-scripts steht beim Installieren'
else
  bad 'kein --ignore-scripts — ein frisch gehobenes Paket dürfte sein Postinstall fahren'
fi
if grep -qF -- '--frozen-lockfile' <<<"$CODE"; then
  ok '--frozen-lockfile steht daneben'
else
  bad 'kein --frozen-lockfile — die Sperrdatei könnte sich beim Installieren ändern'
fi
# This workflow deliberately does not reuse `setup-workspace`: that composite
# action has no `--ignore-scripts` of its own (see the action's own install
# step). Reusing it here would silently drop the one flag that matters.
if grep -qF './.github/actions/setup-workspace' <<<"$CODE"; then
  bad 'setup-workspace wird wiederverwendet — die kennt kein --ignore-scripts'
else
  ok 'setup-workspace wird nicht wiederverwendet (kennt kein --ignore-scripts)'
fi

printf '\n== Die Liste wird erzeugt, nicht nur geprüft ==\n'
if grep -qE '^\s*run: node tools/licences\.ts\s*$' "$WORKFLOW"; then
  ok 'node tools/licences.ts läuft im Schreibmodus'
else
  bad 'tools/licences.ts läuft nicht ohne --check — nichts würde regeneriert'
fi
if grep -qF 'licences.ts --check' <<<"$CODE"; then
  bad 'der Workflow ruft --check auf — er soll schreiben, nicht nur vergleichen'
else
  ok 'kein --check in diesem Workflow'
fi

printf '\n== Nur bei tatsächlicher Änderung wird committet ==\n'
if grep -qF 'git status --porcelain' "$WORKFLOW"; then
  ok 'die Änderung wird geprüft, bevor irgendetwas committet wird'
else
  bad 'keine Prüfung auf Änderung — das wäre ein leerer Commit auf jeder PR'
fi
if grep -qE "if: steps\.diff\.outputs\.changed == 'true'" "$WORKFLOW"; then
  ok 'der Commit-Schritt hängt an genau dieser Prüfung'
else
  bad 'der Commit-Schritt ist nicht an die Änderungsprüfung gebunden'
fi

printf '\n== Der Push geht auf den PR-Branch, mit dem PAT ==\n'
if grep -qE 'git push origin "HEAD:\$\{\{ github\.event\.pull_request\.head\.ref \}\}"' "$WORKFLOW"; then
  ok 'gepusht wird auf den Kopf-Branch des PRs'
else
  bad 'der Push zielt nicht erkennbar auf den PR-Branch'
fi
if grep -qF 'secrets.DEPENDABOT_FIXUP_TOKEN' "$WORKFLOW"; then
  ok 'der PAT (DEPENDABOT_FIXUP_TOKEN) wird verwendet'
else
  bad 'kein DEPENDABOT_FIXUP_TOKEN — ein Push mit GITHUB_TOKEN löst keinen neuen Lauf aus'
fi
# GITHUB_TOKEN must not appear anywhere in this file: it is read-only for
# this actor in the first place, and using it for anything here would be the
# exact mistake ADR-0031 explains away.
if grep -qF 'secrets.GITHUB_TOKEN' "$WORKFLOW"; then
  bad 'secrets.GITHUB_TOKEN wird verwendet — für diesen Akteur ohnehin nur lesend'
else
  ok 'kein GITHUB_TOKEN im Spiel'
fi

printf '\n== Gleiche Node-Fassung wie der reguläre Workspace-Aufbau ==\n'
node_version_here="$(grep -oE "node-version: '[0-9.]+'" "$WORKFLOW" | head -n1)"
node_version_there="$(grep -oE "node-version: '[0-9.]+'" "$SETUP_WORKSPACE" | head -n1)"
if [ -n "$node_version_here" ] && [ "$node_version_here" = "$node_version_there" ]; then
  ok "beide setzen $node_version_here"
else
  bad "Node-Fassung weicht ab: hier '$node_version_here', in setup-workspace '$node_version_there'"
fi

printf '\n'
if [ "$failures" -eq 0 ]; then
  printf '\033[32mOK: die Gestalt des dependabot-licences-Workflows stimmt.\033[0m\n'
  exit 0
fi
printf '\033[31m%d Abweichung(en).\033[0m\n' "$failures"
exit 1
