#!/usr/bin/env bash
#
# ci-docs-only.sh — decides whether a push changed *only* documentation, so
# the heavier CI jobs (test, e2e, stack) can let their own steps skip
# themselves without the job itself disappearing as `skipped`.
#
# Why a job-level `if:` or `on.push.paths-ignore` is *not* used for this: both
# make the check run vanish (or show as `skipped`) for a docs-only push, and a
# skipped required check can block a future branch protection rule from ever
# going green — `main` is unprotected today, and this should not be the reason
# it has to stay that way. Instead, the job always runs; only its steps after
# this one are conditioned on the output below.
#
# Kept as its own script rather than inline YAML so the decision is runnable
# and checkable locally — see the CI docs for the exact commands used to
# verify it (docs/kb/04-build-run.md, "Die Pipeline").
#
# Usage:
#   scripts/ci-docs-only.sh <before-sha> <after-sha> [default-branch-ref]
#
# Writes `docs_only=true` or `docs_only=false` to $GITHUB_OUTPUT if that
# variable is set (the workflow step sets it), otherwise to stdout (running
# this by hand, e.g. for the verification above).
#
# The rule, deliberately conservative: `docs_only=true` only if *every*
# changed path starts with `docs/` or is exactly `CHANGELOG.md`. Not
# `AGENTS.md`, not `scripts/`, not `.github/` — those can change behavior, not
# just describe it.
#
# **What the change is measured against, and why it is not `before`.** The
# obvious base is `github.event.before`, the previous push — and it is wrong in
# a way that produces a *false green*: push A changes code and turns `test`
# red (or `cancel-in-progress` throws its run away), push B changes only
# `docs/`, `test` skips its steps and reports **success** on the head commit.
# The branch then carries a green check for a code state nobody ever ran. That
# is precisely the branch-protection case this early exit exists to stay
# compatible with, so the base is the **merge base with the default branch**:
# "docs-only" is then a statement about the whole branch, not about the last
# push.
#
# The price is real and is not hidden: a branch that already contains a code
# change runs the full pipeline on every push, including its docs commits.
# Only a branch that is documentation from its base gets the saving. That is
# the conservative half of the trade, and it is the half worth having.
#
# On the default branch itself there is no merge base to speak of (it resolves
# to the pushed commit), so `before` is used there — which is the right
# semantic anyway: on `main` every commit keeps its own verdict.
#
# The fail-safe direction is not symmetric, and that is on purpose: a wrong
# `true` skips tests that may have needed to run — the expensive mistake. A
# wrong `false` only costs CI minutes. So every doubtful case below resolves
# to `false`, never to `true`:
#   - missing arguments;
#   - an empty changed-file list;
#   - the default branch is not reachable in this checkout, so no merge base
#     can be computed — never fall back to `before` here, that is the hole
#     this base exists to close;
#   - on the default branch (the only place `before` is used, see above):
#     `before` is the all-zero SHA — GitHub's marker for "no prior commit",
#     e.g. the first push of a new branch — or it does not resolve to a
#     commit in this checkout, e.g. a force-push rewrote the history it
#     pointed at;
#   - `git diff` itself fails for any other reason.
#
# Note what is *not* in this list any more: on a non-default branch, `before`
# is never checked for validity (zero SHA / resolvable) — only for presence,
# alongside `after`, in the argument check above. A force-push that
# invalidates it (rewriting the history it pointed at) therefore cannot make
# this script answer `false` when the branch really is docs-only — that was
# the bug this reordering fixes. The `before`-validity checks below run only
# in the branch that actually substitutes `before` for the merge base.
#
set -uo pipefail

ZERO_SHA="0000000000000000000000000000000000000000"
DEFAULT_REF="${3:-refs/remotes/origin/main}"

emit() {
  local value="$1"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "docs_only=$value" >> "$GITHUB_OUTPUT"
  else
    echo "docs_only=$value"
  fi
}

before="${1:-}"
after="${2:-}"

if [[ -z "$before" || -z "$after" ]]; then
  echo "Usage: $0 <before-sha> <after-sha>" >&2
  emit false
  exit 0
fi

# The base of the comparison. See the block at the top of this file for why
# this is the merge base and not `before`.
if ! git cat-file -e "${DEFAULT_REF}^{commit}" 2>/dev/null; then
  echo "ci-docs-only: $DEFAULT_REF is not reachable in this checkout — not docs-only" >&2
  emit false
  exit 0
fi

base="$(git merge-base "$DEFAULT_REF" "$after" 2>/dev/null)"
if [[ -z "$base" ]]; then
  echo "ci-docs-only: no merge base between $DEFAULT_REF and $after — not docs-only" >&2
  emit false
  exit 0
fi

# On the default branch the merge base *is* the pushed commit, so it would
# describe an empty change. `before` is both the only usable base there and
# the right one: on `main` every commit keeps its own verdict. This is also
# the *only* place `before` is needed at all — on any other branch the merge
# base above already is the comparison base, and `before` is irrelevant to
# the decision (a force-push that invalidates it must not turn into a
# `false` verdict for a branch that never needed it).
if [[ "$base" == "$(git rev-parse "${after}^{commit}" 2>/dev/null)" ]]; then
  if [[ "$before" == "$ZERO_SHA" ]]; then
    echo "ci-docs-only: before is the all-zero SHA (new branch) — not docs-only" >&2
    emit false
    exit 0
  fi

  if ! git cat-file -e "${before}^{commit}" 2>/dev/null; then
    echo "ci-docs-only: $before does not resolve to a commit here (force-push?) — not docs-only" >&2
    emit false
    exit 0
  fi

  echo "ci-docs-only: on the default branch — comparing against $before" >&2
  base="$before"
fi

# `--no-renames`, and this is the one flag that keeps the rule honest.
# `git diff --name-only` detects renames and then prints only the *destination*
# path — so moving `README.md` to `docs/README.md` reports a single path under
# `docs/`, and this script would answer `true` about a push that deleted a file
# outside `docs/`. Measured, not feared: with rename detection the move above
# prints `docs/README.md`; with `--no-renames` it prints both sides. The rule
# says "every changed path", so it has to see every changed path.
files="$(git diff --no-renames --name-only "$base" "$after" 2>/dev/null)"
if [[ $? -ne 0 ]]; then
  echo "ci-docs-only: git diff failed — not docs-only" >&2
  emit false
  exit 0
fi

if [[ -z "$files" ]]; then
  echo "ci-docs-only: no changed files reported — not docs-only" >&2
  emit false
  exit 0
fi

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  if [[ "$file" != docs/* && "$file" != "CHANGELOG.md" ]]; then
    echo "ci-docs-only: $file is outside docs/ and is not CHANGELOG.md — not docs-only" >&2
    emit false
    exit 0
  fi
done <<< "$files"

emit true
