#!/usr/bin/env bash
#
# ci-docs-only.test.sh — regression test for scripts/ci-docs-only.sh.
#
# A shell test over a real, disposable Git repository rather than Vitest: the
# thing under test *is* a shell script whose whole job is talking to `git`
# (merge-base, cat-file, diff --no-renames) — reproducing that faithfully in
# a mocked test runner would mean re-implementing git's ref/history model in
# TypeScript, while a throwaway `git init` gives the real thing for the cost
# of a temp directory.
#
# Usage:
#   scripts/tests/ci-docs-only.test.sh [path-to-script-under-test]
#
# Defaults to scripts/ci-docs-only.sh (the current version). The script path
# is a parameter, not a hardcoded path, so the same scenarios can be pointed
# at a different copy — e.g. a deliberately-broken one, to check that a
# scenario actually fails when the guard it tests for is removed.
#
# Exit code: 0 = all scenarios matched, 1 = at least one mismatch.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_UNDER_TEST="$(cd "$(dirname "${1:-$ROOT/scripts/ci-docs-only.sh}")" && pwd)/$(basename "${1:-ci-docs-only.sh}")"

failures=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; failures=$((failures+1)); }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

repo() { git -C "$work" "$@" >/dev/null 2>&1; }
repo_out() { git -C "$work" "$@" 2>/dev/null; }

# One shared repo, built up scenario by scenario, matches how these cases
# actually arise on a real branch (a branch is docs-only *from its base*, not
# in isolation) and keeps the fixture short.
repo init -q -b main
repo -c user.email=test@example.com -c user.name=Test commit --allow-empty -m "chore: root"

# $6 (optional): a substring that must appear on stderr. Without it, a
# scenario only checks the output value — and a mutant that reaches `false`
# by an unrelated path (e.g. because a later, unrelated step also fails)
# would pass it just the same. Checking the stderr line pins the scenario to
# the *reason*, not merely the outcome; see cases 3b/3c below, where this
# matters (a removed guard would otherwise still answer `false`, just for
# the wrong reason, further down in the script).
check() {
  local label="$1" before="$2" after="$3" default_ref="$4" expected="$5"
  local stderr_needle="${6:-}"
  local actual err_file
  err_file="$(mktemp)"
  # The script decides by talking to `git` in the current directory (merge-base,
  # cat-file, diff) — it has to run *inside* the fixture repo, not this one.
  actual="$(cd "$work" && GITHUB_OUTPUT= bash "$SCRIPT_UNDER_TEST" "$before" "$after" "$default_ref" \
    2>"$err_file" | sed -n 's/^docs_only=//p')"
  actual="${actual:---no-output--}"
  if [[ "$actual" != "$expected" ]]; then
    bad "$label -> $actual (expected $expected)"
  elif [[ -n "$stderr_needle" ]] && ! grep -qF "$stderr_needle" "$err_file"; then
    bad "$label -> $actual, but stderr did not contain '$stderr_needle' (got: $(cat "$err_file"))"
  else
    ok "$label -> $actual"
  fi
  rm -f "$err_file"
}

printf 'Testing: %s\n\n' "$SCRIPT_UNDER_TEST"

# --- Fixture: main with one real (non-docs) file --------------------------
echo "hello" > "$work/README.md"
repo add README.md
repo -c user.email=test@example.com -c user.name=Test commit -m "chore: seed README"
main_tip="$(repo_out rev-parse HEAD)"

# --- Case 1: docs-only branch over main, `before` unresolvable -------------
# The bug this package fixes: a force-pushed feature branch whose docs
# commits sit on top of main, where `before` names a commit this checkout has
# never seen (the old history it pointed at is gone). Non-default branch, so
# `before` must not matter at all.
repo checkout -q -b feature/case1 main
mkdir -p "$work/docs"
echo "note" > "$work/docs/note.md"
repo add docs/note.md
repo -c user.email=test@example.com -c user.name=Test commit -m "docs: add note"
case1_after="$(repo_out rev-parse HEAD)"
fake_before="0123456789abcdef0123456789abcdef01234567"
check "case 1: docs-only branch, before unresolvable (force-push)" \
  "$fake_before" "$case1_after" "refs/heads/main" "true"

# --- Case 2: code change, then a docs commit, over main --------------------
# The price of the merge-base fix: once any commit on the branch touched
# code, every later push (including a docs-only one) runs the full pipeline.
repo checkout -q -b feature/case2 main
echo "changed" >> "$work/README.md"
repo add README.md
repo -c user.email=test@example.com -c user.name=Test commit -m "fix: change README"
code_commit="$(repo_out rev-parse HEAD)"
mkdir -p "$work/docs"
echo "note" > "$work/docs/case2.md"
repo add docs/case2.md
repo -c user.email=test@example.com -c user.name=Test commit -m "docs: add case2 note"
case2_after="$(repo_out rev-parse HEAD)"
check "case 2: code change then docs commit over main" \
  "$code_commit" "$case2_after" "refs/heads/main" "false"

# --- Case 3a: default branch itself, docs commit, before resolves ---------
repo checkout -q main
before_main="$(repo_out rev-parse HEAD)"
mkdir -p "$work/docs"
echo "note" > "$work/docs/on-main.md"
repo add docs/on-main.md
repo -c user.email=test@example.com -c user.name=Test commit -m "docs: note directly on main"
after_main_docs="$(repo_out rev-parse HEAD)"
check "case 3a: default branch, docs commit" \
  "$before_main" "$after_main_docs" "refs/heads/main" "true"

# --- Case 3b: default branch itself, `before` unresolvable -----------------
# The stderr check is load-bearing here: without it, deleting the
# `cat-file -e "${before}^{commit}"` guard still answers `false` for this
# input (because `git diff` then fails on the bad SHA further down and *that*
# path also emits `false`) — six green scenarios that prove nothing about the
# guard they claim to cover. Pinning the message ties the case to the guard.
check "case 3b: default branch, before unresolvable" \
  "$fake_before" "$after_main_docs" "refs/heads/main" "false" \
  "does not resolve to a commit"

# --- Case 3c: default branch itself, `before` is the all-zero SHA ---------
# Not covered anywhere else: a mutant without the ZERO_SHA guard passes every
# other scenario here, since none of them ever pass the zero SHA as `before`.
zero_sha="0000000000000000000000000000000000000000"
check "case 3c: default branch, before is the all-zero SHA" \
  "$zero_sha" "$after_main_docs" "refs/heads/main" "false" \
  "all-zero SHA"

# --- Case 4: default ref unreachable ---------------------------------------
check "case 4: default ref unreachable" \
  "$before_main" "$after_main_docs" "refs/heads/does-not-exist" "false"

# --- Case 5: rename across the docs/ boundary ------------------------------
# `--no-renames` must keep seeing both sides of the move; without it, this
# would print only "docs/README.md" and wrongly answer `true`.
repo checkout -q -b feature/case5 main
mkdir -p "$work/docs"
repo mv README.md docs/README-moved.md
repo -c user.email=test@example.com -c user.name=Test commit -m "docs: move README under docs/"
case5_after="$(repo_out rev-parse HEAD)"
check "case 5: rename across docs/ boundary" \
  "$main_tip" "$case5_after" "refs/heads/main" "false"

printf '\n'
if [[ "$failures" -eq 0 ]]; then
  printf '\033[32mOK: all scenarios matched.\033[0m\n'
  exit 0
fi
printf '\033[31m%d scenario(s) mismatched - see above.\033[0m\n' "$failures"
exit 1
