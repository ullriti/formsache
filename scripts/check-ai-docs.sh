#!/usr/bin/env bash
#
# check-ai-docs.sh — mechanical check that the agent/knowledge files are used
# structurally correctly (right folders, index entries, required sections).
# Complements the judgment checks in the /audit-ai-docs command.
#
# Usage:
#   scripts/check-ai-docs.sh          # check, exit 1 on findings
#
# Exit code: 0 = clean, 1 = at least one finding (CI-friendly).
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

findings=0
section() { printf '\n== %s ==\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$1"; findings=$((findings+1)); }

# 1) Required files / folders
section "Structure"
for f in AGENTS.md CLAUDE.md CHANGELOG.md \
         docs/kb/README.md; do
  [[ -f "$f" ]] && ok "present: $f" || warn "missing: $f"
done
[[ -d docs/architecture ]] && ok "present: docs/architecture/" \
  || warn "missing: docs/architecture/"

# 2) CLAUDE.md pulls in AGENTS.md via import
section "CLAUDE.md → AGENTS.md"
if grep -q '@AGENTS.md' CLAUDE.md 2>/dev/null; then
  ok "CLAUDE.md imports @AGENTS.md"
else
  warn "CLAUDE.md has no '@AGENTS.md' import"
fi

# 3) Required sections
section "Required sections"
grep -q '\[Unreleased\]' CHANGELOG.md 2>/dev/null \
  && ok "CHANGELOG has '[Unreleased]'" \
  || warn "CHANGELOG.md: '[Unreleased]' section missing"

# 4) Naming/placement convention: specs & ADRs = NNNN-*.md
section "Naming convention ADRs"
for dir in docs/architecture; do
  [[ -d "$dir" ]] || continue
  for f in "$dir"/*.md; do
    [[ -e "$f" ]] || continue
    base="$(basename "$f")"
    [[ "$base" == "README.md" ]] && continue
    if [[ "$base" =~ ^[0-9]{4}- ]]; then
      ok "$dir/$base"
    else
      warn "$dir/$base: expected 'NNNN-title.md' (wrong place/name?)"
    fi
  done
done

# 5) Dead paths and anchors in the knowledge documents (KB, specs, ADRs)
#
# A statement whose evidence path has moved documents something that is no
# longer there. `tools/check-doc-links.ts` holds every reference against the
# file system: Markdown links, their anchors, and repository paths written in
# inline code.
# It is a separate file because the anchor rules need real Unicode handling —
# `tr '[:upper:]'` does not lowercase „Störfall".
section "Knowledge documents: dead paths & anchors"
if ! command -v node >/dev/null 2>&1; then
  # Not "skip": the guard would report nothing and look clean.
  warn "node not found — cannot check paths/anchors in docs/kb, docs/architecture"
else
  doc_link_output="$(node "$ROOT/tools/check-doc-links.ts" 2>&1)"
  doc_link_status=$?
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    if [[ "$doc_link_status" -eq 0 ]]; then ok "$line"; else warn "$line"; fi
  done <<<"$doc_link_output"
fi

# Result
printf '\n'
if [[ "$findings" -eq 0 ]]; then
  printf '\033[32mOK: no structural findings.\033[0m\n'
  exit 0
fi
printf '\033[33m%d finding(s) – see above.\033[0m\n' "$findings"
exit 1
