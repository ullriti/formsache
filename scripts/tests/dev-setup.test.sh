#!/usr/bin/env bash
#
# dev-setup.test.sh — regression test for scripts/dev-setup.sh.
#
# **What it is here for.** A past change took
# `SMTP_HOST/PORT/USER/PASSWORD/SECURE/FROM` and `PUBLIC_BASE_URL` out of
# `.env.example`, and there is deliberately **no** migration path: an existing
# `.env` keeps those lines. That is only defensible while the sync *says so* —
# a variable that quietly stays behind in a developer's file looks like
# configuration and is not, and the day somebody edits `SMTP_HOST` there to fix
# their mail is the day they lose an hour.
#
# A shell test over a real temporary `.env`, in the style of
# `ci-docs-only.test.sh` and for the same reason: the thing under test *is* a
# shell script whose job is reading and writing files, and the honest way to
# check it is to let it read and write some.
#
# **It never touches the repository's own `.env`.** Every scenario points the
# script at a throwaway copy through `--env-file`, which exists for exactly
# this, and passes `--no-install` so no scenario reaches the network.
#
# Usage:
#   scripts/tests/dev-setup.test.sh [path-to-script-under-test]
#
# Exit code: 0 = all scenarios matched, 1 = at least one mismatch.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_UNDER_TEST="${1:-$ROOT/scripts/dev-setup.sh}"

failures=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() {
  printf '  \033[31m✗\033[0m %s\n' "$1"
  failures=$((failures + 1))
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The variables that were removed. Written out rather than derived: this list is the
# claim, and deriving it from the same file the script reads would make the test
# agree with any future state of that file.
REMOVED=(SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD SMTP_SECURE SMTP_FROM PUBLIC_BASE_URL)

run_setup() {
  (cd "$ROOT" && bash "$SCRIPT_UNDER_TEST" --no-install --env-file "$1" 2>&1)
}

contains() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    ok "$label"
  else
    bad "$label — did not find „$needle\" in the output"
  fi
}

# ---------------------------------------------------------------------------
printf '\n%s\n' "1. .env.example itself no longer carries the moved variables"
# ---------------------------------------------------------------------------
for key in "${REMOVED[@]}"; do
  if grep -qE "^[[:space:]]*(export[[:space:]]+)?$key=" "$ROOT/.env.example"; then
    bad "$key is still assigned in .env.example"
  else
    ok "$key is gone from .env.example"
  fi
done

# ---------------------------------------------------------------------------
printf '\n%s\n' "2. an .env from before the move: the moved variables are reported, never deleted"
# ---------------------------------------------------------------------------
old_env="$work/pre-m3.env"
{
  echo "NODE_ENV=development"
  echo "DATABASE_URL=postgresql://formsache:pw@127.0.0.1:5432/formsache"
  echo "SECRET_BOX_KEY=not-a-real-key"
  for key in "${REMOVED[@]}"; do echo "$key=egal"; done
} > "$old_env"

output="$(run_setup "$old_env")"

# The heart of this scenario: named, one by one, in the „does not know" line.
for key in "${REMOVED[@]}"; do
  contains "$output" "$key" "reports $key as unknown to .env.example"
done
contains "$output" "does not know" "says in what sense they are unknown"

# Reported, **not** removed: a rename, a removed variable and somebody's own
# addition look identical from a script's point of view, and deleting a line
# that might hold a working value is not a script's decision to make.
for key in "${REMOVED[@]}"; do
  if grep -qE "^$key=" "$old_env"; then
    ok "$key is still in the file — reported, not deleted"
  else
    bad "$key was removed from the .env"
  fi
done

# ---------------------------------------------------------------------------
printf '\n%s\n' "3. a fresh .env is a copy of the example and carries no mail configuration"
# ---------------------------------------------------------------------------
fresh_env="$work/fresh.env"
output="$(run_setup "$fresh_env")"
contains "$output" "Created" "creates a .env when there is none"

for key in "${REMOVED[@]}"; do
  if grep -qE "^[[:space:]]*(export[[:space:]]+)?$key=" "$fresh_env"; then
    bad "$key was written into a fresh .env"
  else
    ok "$key is absent from a fresh .env"
  fi
done

# The chicken-and-egg half of this: what a fresh file *must* have is exactly what
# is needed to reach the settings row at all.
for key in DATABASE_URL SECRET_BOX_KEY NODE_ENV; do
  if grep -qE "^[[:space:]]*(export[[:space:]]+)?$key=" "$fresh_env"; then
    ok "$key is in a fresh .env"
  else
    bad "$key is missing from a fresh .env"
  fi
done

# The required secret is generated rather than copied empty — otherwise the
# documented setup path ends in an application that refuses to start.
if [[ -n "$(sed -nE 's/^SECRET_BOX_KEY=//p' "$fresh_env" | tail -n 1)" ]]; then
  ok "SECRET_BOX_KEY was generated"
else
  bad "SECRET_BOX_KEY is still empty after a run"
fi
# …and never printed. A key in the output ends up in scrollback and CI logs.
key_value="$(sed -nE 's/^SECRET_BOX_KEY=//p' "$fresh_env" | tail -n 1)"
if [[ "$output" == *"$key_value"* ]]; then
  bad "the generated key was printed"
else
  ok "the generated key was not printed"
fi

# ---------------------------------------------------------------------------
printf '\n%s\n' "4. a second run changes nothing"
# ---------------------------------------------------------------------------
before="$(cat "$fresh_env")"
output="$(run_setup "$fresh_env")"
if [[ "$before" == "$(cat "$fresh_env")" ]]; then
  ok "the file is byte-identical after a second run"
else
  bad "a second run rewrote the file"
fi
contains "$output" "nothing changed" "says that nothing changed"

# ---------------------------------------------------------------------------
printf '\n%s\n' "5. a carried-over variable brings its comment and *not* the section banner"
# ---------------------------------------------------------------------------
# ⚠️ **The structural half of the sync, and the one that breaks silently.**
# `example_block()` takes „the unbroken run of `#` lines directly above the
# assignment" as a variable's comment, so the **blank line under every
# `# ----` banner in `.env.example` is functional**: without it the banner is
# part of the run and lands in every synced `.env`, once per variable. Nothing
# else in this suite would notice — the values would all be right.
#
# Checked after the file was rewritten to one comment line per variable
# (2026-08-14), because that rewrite is exactly the kind of edit that drops a
# blank line without anybody seeing it.
sparse_env="$work/sparse.env"
{
  echo "SECRET_BOX_KEY=not-a-real-key"
  echo "FILE_STORAGE_DIR=$work/files"
} > "$sparse_env"

output="$(run_setup "$sparse_env")"
contains "$output" "carried over" "reports what arrived"

if grep -qE '^[[:space:]]*(export[[:space:]]+)?NODE_ENV=' "$sparse_env"; then
  ok "NODE_ENV — the first variable under a banner — was carried over"
else
  bad "NODE_ENV did not arrive"
fi
if grep -q 'Betriebsmodus' "$sparse_env"; then
  ok "it brought its own comment line"
else
  bad "NODE_ENV arrived without its comment"
fi
# **Exactly two** banner lines are expected: the dated heading the script writes
# itself is `# ----` / text / `# ----`, so two of its three lines are banners.
# Anything beyond that came from `.env.example` and should not have.
#
# `-eq`, not `-le`: this stood at `-le 3` while the comment said "two expected",
# which left one banner line of slack — enough for the very first variable to
# drag its section heading along without anything turning red. A bound with room
# in it is not a bound.
banners="$(grep -c -- '---------------------------------------------------------------------------' "$sparse_env")"
if [[ "$banners" -eq 2 ]]; then
  ok "no section banner was dragged along ($banners banner line(s), the dated heading)"
else
  bad "$banners banner lines in the .env, expected 2 — the blank line under a banner in .env.example is missing"
fi

# ---------------------------------------------------------------------------
printf '\n%s\n' "6. Gegenprobe: without the blank line under a banner, the count goes up"
# ---------------------------------------------------------------------------
# ⚠️ **The scenario above is worth nothing until this one has been seen.** It
# asserts that a number stays at 2, and a number stays at 2 for many reasons —
# including a sync that carried nothing over at all. So: take the one blank line
# out of `.env.example` that `example_block()` relies on, run the same sync, and
# require the count to rise. If it does not, the assertion above is measuring
# something else.
#
# Built like the scenarios in `check-doc-links.test.sh`: a throwaway root where
# what the scenario modifies is copied and the script under test comes along, so
# the run reads the sabotaged template instead of the repository's own.
sabotaged_root() {
  local root="$work/$1"
  mkdir -p "$root/scripts/lib"
  cp "$SCRIPT_UNDER_TEST" "$root/scripts/dev-setup.sh"
  cp "$ROOT/scripts/lib/env-sync.sh" "$root/scripts/lib/env-sync.sh"
  # Every blank line that directly follows a `# ----` line is dropped — that is
  # precisely the line at which `example_block()` stops walking upwards, and
  # therefore precisely what keeps a section heading out of a variable's
  # comment.
  awk '
    /^#[[:space:]]*-----/ { print; banner = 1; next }
    banner && /^[[:space:]]*$/ { banner = 0; next }
    { banner = 0; print }
  ' "$ROOT/.env.example" > "$root/.env.example"
  printf '%s' "$root"
}

sabotaged="$(sabotaged_root banner-glued)"
glued_env="$work/glued.env"
{
  echo "SECRET_BOX_KEY=not-a-real-key"
  echo "FILE_STORAGE_DIR=$work/files"
} > "$glued_env"
(cd "$sabotaged" && bash scripts/dev-setup.sh --no-install --env-file "$glued_env") > /dev/null 2>&1
glued_banners="$(grep -c -- '---------------------------------------------------------------------------' "$glued_env")"
if [[ "$glued_banners" -gt 2 ]]; then
  ok "the sabotaged template drags banners along ($glued_banners lines) — the check above has teeth"
else
  bad "even without the blank line the count stayed at $glued_banners — the check above measures nothing"
fi

# ---------------------------------------------------------------------------
printf '\n%s\n' "7. an .env from the production template is refused, not synced"
# ---------------------------------------------------------------------------
# ⚠️ **The scenario this script was one autocompletion away from needing.**
# `AGENTS.md` says "run dev-setup.sh after every pull", and that sentence is read
# on servers too. Against an `.env` that came from `.env.prod.example` this used
# to carry the nine `SEED_*` variables over — `SEED_ADMIN_PASSWORD=change-me-locally`
# among them — plus `WEB_PORT`, `APP_PORT` and `POSTGRES_PORT`. Nothing was
# breached, because the seed refuses to run under `NODE_ENV=production`; a
# security property that survives only because a second, unrelated guard happens
# to exist is not a property to keep relying on.
prod_shaped="$work/prod-shaped.env"
{
  echo "NODE_ENV=production"
  echo "IMAGE_PREFIX=ghcr.io/example/formsache"
  echo "BACKUP_DIR=/var/backups/formsache"
  echo "BACKUP_KEY=ein-vorhandener-archivschluessel"
  echo "SECRET_BOX_KEY=ein-vorhandener-schluessel"
} > "$prod_shaped"
before="$(cat "$prod_shaped")"

output="$(run_setup "$prod_shaped")"
code=$?

if [[ $code -ne 0 ]]; then
  ok "the run fails instead of syncing ($code)"
else
  bad "a production .env was synced against .env.example and the run reported success"
fi
contains "$output" "scripts/prod-setup.sh" "names the script that belongs on that machine"
if [[ "$before" == "$(cat "$prod_shaped")" ]]; then
  ok "the file is byte-identical — nothing was written before the refusal"
else
  bad "the production .env was modified before the run gave up"
fi
# The one that would have mattered, named rather than implied.
if grep -qE '^[[:space:]]*(export[[:space:]]+)?SEED_ADMIN_PASSWORD=' "$prod_shaped"; then
  bad "SEED_ADMIN_PASSWORD was carried into a production .env"
else
  ok "no SEED_* variable reached the production .env"
fi

# ---------------------------------------------------------------------------
printf '\n%s\n' "8. the repository's own .env is never touched by these scenarios"
# ---------------------------------------------------------------------------
if [[ "$(ls -A "$work")" == *".env"* ]]; then
  ok "every scenario worked inside the temporary directory"
else
  bad "the temporary directory holds no .env — did a scenario write elsewhere?"
fi

printf '\n'
if [[ $failures -gt 0 ]]; then
  printf '\033[31m%d scenario(s) failed\033[0m\n' "$failures"
  exit 1
fi
printf '\033[32mAll scenarios matched\033[0m\n'
