#!/usr/bin/env bash
#
# dev-setup.sh — prepares and updates the local `.env` for humans, agents and CI.
#
# Two jobs, and the second is the one that comes up more often:
#
#   1. Set up a fresh checkout. `cp .env.example .env` is not the whole story:
#      `.env.example` carries the required secrets *without* a value on purpose
#      — an example key in the repository is a key everybody has. Filling them
#      in is the one setup step nobody can copy from a file.
#
#   2. Keep an existing `.env` in step with `.env.example`. A `.env` from three
#      weeks ago does not learn about new variables from a `git pull`, and the
#      way that surfaces today is either a Zod error at startup or — worse — an
#      optional variable silently running on its default and doing something
#      other than what the branch expects.
#
# So this is not a one-off setup script: run it after every pull. Safe to run
# repeatedly — nothing that already has a value is ever touched.
#
# This is also the **only** setup script (`scripts/bootstrap.sh` is gone). The
# split used to be: `bootstrap.sh` installs, `dev-setup.sh` writes `.env` and
# tells you to run it "after every pull that touched `.env.example`". Nothing
# ever told you to re-run `bootstrap.sh` after a pull that touched a
# `package.json` — so the change that added SMTP support pulled in
# `nodemailer`, and following the
# documented routine to the letter got you `Cannot find module 'nodemailer'`,
# a message that reads like a broken checkout, not a missing package. The
# instructions were the bug, not the reader. One script, one thing to
# remember: run this after every pull.
#
# Usage:
#   scripts/dev-setup.sh              # write/sync .env, install, generate Prisma client
#   scripts/dev-setup.sh --no-install # write/sync .env only — for callers that
#                                      # never touch the workspace (e.g. the CI
#                                      # `stack` job, which only needs `.env`
#                                      # for `docker compose`)
#   scripts/dev-setup.sh --env-file P # sync a `.env` at P instead of ./.env
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE=".env"
EXAMPLE_FILE=".env.example"
# Whether `$ENV_FILE` is the repository's own — see the `--env-file` block.
ENV_FILE_IS_DEFAULT=1
# How the dated heading in a synced `.env` names its author.
SYNC_ORIGIN="scripts/dev-setup.sh"

# The mechanics, shared with `scripts/prod-setup.sh`: reading and writing
# assignments, the sync itself, the reports. Two entry points, one mechanism —
# the reasoning and the contract are at the top of that file.
# shellcheck source=lib/env-sync.sh
source "$ROOT/scripts/lib/env-sync.sh"

INSTALL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-install)
      INSTALL=0
      ;;
    # Which `.env` to write. **Additive, and the default is unchanged**: it
    # exists so the sync can be exercised against a throwaway copy
    # (`scripts/tests/dev-setup.test.sh`) instead of
    # against the developer's real file. This promises that the
    # variables that left `.env.example` are *reported* rather than
    # silently left standing, and a promise about a script nobody can run
    # safely in a test is a promise nobody checks.
    --env-file)
      shift
      if [[ $# -eq 0 ]]; then
        echo "==> --env-file needs a path" >&2
        exit 1
      fi
      ENV_FILE="$1"
      ENV_FILE_IS_DEFAULT=0
      ;;
    --env-file=*)
      ENV_FILE="${1#--env-file=}"
      ENV_FILE_IS_DEFAULT=0
      ;;
    *)
      echo "==> Unknown argument: $1" >&2
      echo "    Supported: --no-install (skip installing dependencies and generating the Prisma client)" >&2
      echo "               --env-file PATH (write/sync this file instead of ./.env)" >&2
      exit 1
      ;;
  esac
  shift
done

# Variables that must carry a generated secret and cannot be shipped with one.
# The next candidate is the OIDC client secret — adding it is
# one line here, nothing else changes.
REQUIRED_SECRETS=(
  SECRET_BOX_KEY
)

# Variables that must name a **directory** and cannot be shipped with a value
# either — for a different reason than the secrets above, and the difference is
# worth a sentence.
#
# `FILE_STORAGE_DIR` (ADR-0014) decides where uploaded attachments are written.
# A path in `.env.example` would look like a default and be adopted as one, so
# that file documents the variable and leaves it empty; the API refuses to
# start without it (there is no fallback into a temp directory — that is the
# failure nobody notices). What is left is the local case, and it is this
# script's job: pick a path next to the `.env` that names it, create it, and
# never touch a value somebody already wrote.
#
# Created rather than only written, because the adapter deliberately does *not*
# create it at runtime: a directory that appears by itself would hide a volume
# that failed to mount.
REQUIRED_DIRECTORIES=(
  "FILE_STORAGE_DIR:var/files"
)

# 32 random bytes as base64 — exactly the format `.env.example` documents, so
# what this writes is what a human would have typed.
generate_secret() {
  if command -v openssl > /dev/null 2>&1; then
    openssl rand -base64 32
  elif command -v node > /dev/null 2>&1; then
    # Fallback rather than a hard stop: Node 22 is a prerequisite of this
    # repository anyway, and `randomBytes` draws from the same
    # OS entropy source openssl does. So a machine that can run the API can
    # always produce a key, even on a minimal image without openssl.
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))'
  else
    echo "==> Neither openssl nor node found — cannot generate a key." >&2
    echo "    Install one of them, or add the value to $ENV_FILE by hand:" >&2
    echo "      openssl rand -base64 32" >&2
    return 1
  fi
}

changed=0
added=()
orphans=()

require_example

# ⚠️ **A production `.env` is not synced against the development template.**
# The full reasoning is at `refuse_foreign_env()` in `scripts/lib/env-sync.sh`;
# the short version is that "run the setup script after every pull" is written
# down for both machines, and this script run on a server used to carry the nine
# `SEED_*` variables — `SEED_ADMIN_PASSWORD=change-me-locally` among them — plus
# `WEB_PORT`, `APP_PORT` and `POSTGRES_PORT` into its `.env`.
#
# The three keys below exist **only** in `.env.prod.example`, so any one of them
# identifies the file beyond doubt. `SECRET_BOX_KEY` and `POSTGRES_USER` are in
# both templates and would identify nothing.
refuse_foreign_env 'scripts/prod-setup.sh' 'production' \
  IMAGE_PREFIX BACKUP_KEY BACKUP_DIR

create_env_from_example
sync_from_example

for key in "${REQUIRED_SECRETS[@]}"; do
  if [[ -n "$(env_value "$key")" ]]; then
    continue
  fi
  # Through a variable, not inline in the call: a failing command substitution
  # in an argument would be swallowed and would write an empty value, which is
  # exactly the silent half-setup this script exists to prevent.
  #
  # The value is never echoed, not even once — a key in the output ends up in
  # terminal scrollback, CI logs and chat transcripts, and is a key nobody can
  # call secret afterwards.
  secret="$(generate_secret)"
  set_env_value "$key" "$secret"
  echo "==> $key: key generated (the value is not printed)"
  changed=1
done

# The directory counterpart of the loop above. The path is **absolute** and
# derived from the `.env` being written, not from `$ROOT`: a relative path would
# mean three different directories (this process is started from the repository
# root, from `apps/api` by `pnpm dev`, and from `/app` in the container), and
# anchoring it to the file keeps `--env-file` — the flag the script's own test
# uses — from writing into the developer's checkout.
env_dir="$(cd "$(dirname "$ENV_FILE")" && pwd)"
for entry in "${REQUIRED_DIRECTORIES[@]}"; do
  key="${entry%%:*}"
  suffix="${entry#*:}"
  path="$(env_value "$key")"
  if [[ -z "$path" ]]; then
    path="$env_dir/$suffix"
    set_env_value "$key" "$path"
    echo "==> $key: set to $path"
    changed=1
  fi
  # Also for a path that was already configured: the value survives a pull, the
  # directory may not (a cleaned checkout, a new machine), and the API refuses
  # to start without it. `mkdir -p` on an existing directory is a no-op.
  if ! mkdir -p "$path" 2> /dev/null; then
    echo "==> WARNING: could not create $key ($path) — the API will not start until it exists." >&2
  fi
done

report_sync
warn_if_not_ignored

# Installed dependencies go stale exactly like the `.env` and the Prisma
# client, and this is why the install below is **unconditional** rather than
# guarded on "is there already a node_modules": a guard is exactly the kind of
# condition that quietly does nothing on the one pull that needed it (see the
# `nodemailer` story at the top of this file). `--no-install` is the only way
# out, and it exists for callers that never touch the workspace at all — not
# for callers that merely installed once already.
#
# `pnpm install -r` is idempotent and takes about a second when the lockfile
# already matches, so running it unconditionally costs nothing on the common
# path and buys back the one case that broke.
if [[ $INSTALL -eq 1 ]]; then
  echo "==> Installing dependencies (pnpm install -r)"
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "==> Providing pnpm via corepack (ADR-0006)"
    corepack enable
  fi
  pnpm install -r --silent
else
  echo "==> --no-install: skipping dependency install"
fi

# The Prisma client is generated code, and it goes stale the same way: `prisma
# generate` hangs off `postinstall`, so a pull that adds a column without
# touching a dependency leaves the client a schema behind. What you get then is
# not "please run install" but `Unknown field 'settingsOverride' for select
# statement on model 'Form'` — a message that reads like a bug in code that is
# in fact correct. Regenerating costs a second and removes the class.
#
# The binary lives with the package, not at the root: pnpm links dependencies
# per workspace rather than hoisting them (ADR-0006).
#
# A missing binary after a run *with* install is a hard error, not a friendly
# skip: the install above just ran, so `apps/api/node_modules/.bin/prisma` not
# existing means the checkout or the install itself is broken, and papering
# over that with a log line would hide it until something else fails with a
# confusing message. With `--no-install` the same absence is expected and the
# message says so, naming the flag that caused it.
PRISMA_BIN="apps/api/node_modules/.bin/prisma"
if [[ -x $PRISMA_BIN ]]; then
  echo "==> Regenerating the Prisma client (it follows the schema, not the install)"
  (cd apps/api && ./node_modules/.bin/prisma generate > /dev/null)
elif [[ $INSTALL -eq 1 ]]; then
  echo "==> ERROR: $PRISMA_BIN is missing after an install that just ran." >&2
  echo "    That points at a broken checkout or a failed install, not a step to skip." >&2
  exit 1
else
  echo "==> Skipping the Prisma client — dependencies were not installed (--no-install)."
fi

# Deliberately *not* run here: `prisma migrate deploy`. It needs a reachable
# database, and this script has to work before one exists — the point of it is
# to produce the `.env` that says where that database is.
report_outcome
echo "==> If the pull brought a new migration, apply it:"
echo "    pnpm --filter @formsache/api exec prisma migrate deploy"
