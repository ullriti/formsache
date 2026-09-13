#!/usr/bin/env bash
#
# check-doc-links.test.sh — the counter-proof for `tools/check-doc-links.ts`.
#
# **Why this file exists.** The guard it tests was built because
# `scripts/check-ai-docs.sh` checked dead links in exactly one file. A new
# guard that reports "all resolve" is worth nothing until somebody has seen it
# say the opposite — this project has now found **nine** guards that walked an
# empty or wrong set and stayed green. Two of the scenarios below are therefore
# not about dead links at all: they take the measured set away and require the
# guard to go **red** instead of quietly clean ("it measures nothing").
#
# Every scenario runs against a throwaway root: `docs/`, `scripts/` and
# `tools/` are copied, the code folders are symlinked (the guard resolves
# inline-code paths against the repository root, and copying `apps/` would cost
# a minute for nothing). The repository's own files are never modified.
#
# Usage:
#   scripts/tests/check-doc-links.test.sh [path-to-tool-under-test]
#
# Exit code: 0 = all scenarios matched, 1 = at least one mismatch.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOOL_UNDER_TEST="${1:-$ROOT/tools/check-doc-links.ts}"

failures=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() {
  printf '  \033[31m✗\033[0m %s\n' "$1"
  failures=$((failures + 1))
}

if ! command -v node >/dev/null 2>&1; then
  printf '\033[31mnode not found — the guard cannot be tested.\033[0m\n' >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A fresh throwaway root for one scenario. Copied: what a scenario modifies.
# Symlinked: what it only reads.
new_root() {
  local root="$work/case-$1"
  mkdir -p "$root"
  cp -r "$ROOT/docs" "$root/docs"
  cp -r "$ROOT/scripts" "$root/scripts"
  # Das **ganze** `tools/`, dann der Prüfling darüber. Vorher entstand hier ein
  # `tools/` mit einer einzigen Datei darin, und damit war jedes Dokument, das
  # eine andere Datei unter `tools/` nennt, in diesem Wegwerf-Verzeichnis
  # zwangsläufig rot — ein Fund, den es im Repository gar nicht gab. Aufgefallen
  # ist das erst, als `tools/licences.ts` der erste solche Verweis wurde
  # (Review-Runde 3 Nr. 14); bis dahin nannte kein Dokument etwas aus `tools/`
  # außer dem Prüfling selbst, und die Lücke war unsichtbar.
  #
  # Kopiert und nicht verknüpft, aus demselben Grund wie `docs/` und `scripts/`:
  # ein Fall darf hier schreiben, ohne das Repository anzufassen.
  cp -r "$ROOT/tools" "$root/tools"
  cp "$TOOL_UNDER_TEST" "$root/tools/check-doc-links.ts"
  for dir in apps packages e2e .github; do
    [[ -e "$ROOT/$dir" ]] && ln -s "$ROOT/$dir" "$root/$dir"
  done
  # The documents link *up* to `../../AGENTS.md` and friends, so the root files
  # have to be there too — otherwise scenario 1 fails for the wrong reason.
  find "$ROOT" -maxdepth 1 -type f -exec cp {} "$root/" \;
  printf '%s' "$root"
}

# Runs the guard in a throwaway root and reports whether the outcome and the
# message match. `expect_status` is 0 (clean) or 1 (findings).
check() {
  local label="$1" root="$2" expect_status="$3" expect_text="$4"
  local output status
  output="$(node "$root/tools/check-doc-links.ts" 2>&1)"
  status=$?
  if [[ "$status" -ne "$expect_status" ]]; then
    bad "$label — exit $status, expected $expect_status"
    printf '      %s\n' "${output:0:300}"
    return
  fi
  if [[ -n "$expect_text" && "$output" != *"$expect_text"* ]]; then
    bad "$label — output did not contain „$expect_text\""
    printf '      %s\n' "${output:0:300}"
    return
  fi
  ok "$label"
}

printf '\n== check-doc-links.ts ==\n'

# ---------------------------------------------------------------------------
# 1) The repository as it stands: clean.
# ---------------------------------------------------------------------------
root="$(new_root clean)"
check "unmodified documents: no findings" "$root" 0 "all resolve"

# ---------------------------------------------------------------------------
# 2) A dead Markdown link.
# ---------------------------------------------------------------------------
root="$(new_root dead-link)"
printf '\n[a document that is not there](99-does-not-exist.md)\n' >>"$root/docs/kb/README.md"
check "dead Markdown link → red" "$root" 1 "dead link target: 99-does-not-exist.md"

# ---------------------------------------------------------------------------
# 3) A dead anchor — a link whose file exists but whose heading does not. This
#    is the half that the plain "does the file exist" check cannot see, and the
#    half that actually rotted in this repository (`#offene-punkte`).
# ---------------------------------------------------------------------------
root="$(new_root dead-anchor)"
printf '\n[a heading that is not there](04-build-run.md#gibt-es-nicht)\n' >>"$root/docs/kb/README.md"
check "dead anchor → red" "$root" 1 "dead anchor:"

# ---------------------------------------------------------------------------
# 4) A dead repository path in inline code — the shape a TOM row relies
#    on ("every measure carries a path to its evidence").
# ---------------------------------------------------------------------------
root="$(new_root dead-path)"
printf '\nDie Maßnahme steht in `apps/api/src/gibt-es-nicht.ts`.\n' >>"$root/docs/kb/10-datenschutz.md"
check "dead inline-code path → red" "$root" 1 "path does not exist: apps/api/src/gibt-es-nicht.ts"

# ---------------------------------------------------------------------------
# 5) **The counter-proof that matters.** Take the documents away entirely. A
#    guard that answers "all resolve" over zero files is worse than no guard:
#    it is a green light for an unmeasured area. Both signals are required —
#    the missing folder *and* the lower bounds.
# ---------------------------------------------------------------------------
root="$(new_root no-documents)"
rm -rf "$root/docs/kb" "$root/docs/architecture"
check "no documents at all → red (not silently green)" "$root" 1 "no Markdown documents found"
output="$(node "$root/tools/check-doc-links.ts" 2>&1)"
if [[ "$output" == *"measured only 0 documents"* ]]; then
  ok "no documents at all → the lower bound names it: measures nothing"
else
  bad "no documents at all → expected the lower bound to fire as well"
fi

# ---------------------------------------------------------------------------
# 6) The subtler version of the same failure: the folders are there, but almost
#    everything in them is gone. No dead link is left to find, and the guard
#    still has to refuse to call that a pass.
# ---------------------------------------------------------------------------
root="$(new_root almost-empty)"
find "$root/docs/kb" "$root/docs/architecture" -name '*.md' -delete
printf '# Nur eine Datei\n\nOhne Verweise.\n' >"$root/docs/kb/README.md"
printf '# ADR\n' >"$root/docs/architecture/0001-example.md"
check "two documents, no links → red" "$root" 1 "the guard is running over an (almost) empty set"

# ---------------------------------------------------------------------------
# 7) The exception list guards itself. A path on `RETIRED_PATHS` that exists
#    again would from then on hide a real dead path behind it.
# ---------------------------------------------------------------------------
root="$(new_root retired-returns)"
printf '#!/usr/bin/env bash\n' >"$root/scripts/bootstrap.sh"
check "a retired path that exists again → red" "$root" 1 "exists again — drop it from RETIRED_PATHS"

printf '\n'
if [[ "$failures" -eq 0 ]]; then
  printf '\033[32mOK: all scenarios matched.\033[0m\n'
  exit 0
fi
printf '\033[31m%d scenario(s) failed.\033[0m\n' "$failures"
exit 1
