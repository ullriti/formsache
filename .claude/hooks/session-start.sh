#!/usr/bin/env bash
#
# SessionStart hook: runs when Claude Code starts/resumes a session.
# Prepare the environment here (warm up deps, etc.).
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[baseline hook] Preparing session in $ROOT"

# Warm up dependencies once the monorepo exists. Failures must never block
# the session, hence the guards and the "|| true".
if [[ -f package.json && -f pnpm-lock.yaml ]]; then
  corepack enable >/dev/null 2>&1 || true
  pnpm install -r --frozen-lockfile --prefer-offline >/dev/null 2>&1 || true
fi

echo "[baseline hook] Done."
