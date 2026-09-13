#!/usr/bin/env bash
#
# prod-setup.sh — prepares and updates the `.env` of a **production** host.
#
# The sibling of `scripts/dev-setup.sh`, and deliberately a separate script
# rather than a flag on that one. Two reasons, and both are about what happens
# on the day somebody is in a hurry:
#
#   1. **A different source file.** `.env.prod.example` carries the registry
#      prefix and the backup settings; `.env.example` carries seed accounts, a
#      Vite port and throwaway test databases. A flag that
#      switched between them would be one keystroke away from writing a seed
#      administrator password onto a server.
#   2. **A different set of generated secrets.** Here three values have to be
#      random and cannot ship in a file — `SECRET_BOX_KEY`, `BACKUP_KEY` and
#      `POSTGRES_PASSWORD`. In development the last two do not exist and the
#      database password is a public placeholder on purpose.
#
# What it does **not** do, ever:
#
#   * overwrite an existing `.env` — a running installation's file is the one
#     thing on that machine that cannot be regenerated from the repository;
#   * touch a value that is already set, generated or hand-written;
#   * print a generated secret. A key in the output ends up in scrollback, in a
#     CI log and in a chat transcript, and is a key nobody can call secret
#     afterwards.
#
# Safe to run repeatedly, and meant to be: after a `git pull` that touched
# `.env.prod.example` it carries the new variables over with their comment and
# reports the ones the template no longer knows.
#
# Usage:
#   scripts/prod-setup.sh              # write/sync ./.env from .env.prod.example
#   scripts/prod-setup.sh --env-file P # sync a `.env` at P instead of ./.env
#
# Deliberately **no** `--install` counterpart: a production host runs published
# images (`docker-compose.prod.yml` has no `build:`), so there is no workspace
# to install and no Prisma client to generate. A script that installed here
# would invite building on the server, which is the one thing the production
# shape is built to prevent.
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE=".env"
EXAMPLE_FILE=".env.prod.example"
# Whether `$ENV_FILE` is the repository's own — see the `--env-file` block.
ENV_FILE_IS_DEFAULT=1
# How the dated heading in a synced `.env` names its author.
SYNC_ORIGIN="scripts/prod-setup.sh"

# The mechanics, shared with `scripts/dev-setup.sh`: reading and writing
# assignments, the sync itself, the reports. **Two entry points, one mechanism** —
# what the header above justifies is two scripts, never two copies of the same
# awk call. The contract is at the top of that file.
# shellcheck source=lib/env-sync.sh
source "$ROOT/scripts/lib/env-sync.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    # Which `.env` to write. Additive, and the default is unchanged: it exists
    # so the sync can be exercised against a throwaway copy
    # (`scripts/tests/prod-setup.test.sh`) instead of against a real server's file.
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
      echo "    Supported: --env-file PATH (write/sync this file instead of ./.env)" >&2
      exit 1
      ;;
  esac
  shift
done

# The keys that must be random and cannot be shipped with a value. Plain
# base64, which is the format both templates document.
REQUIRED_SECRETS=(
  SECRET_BOX_KEY
  BACKUP_KEY
)

# ⚠️ **The database password is generated differently, and the difference is
# load-bearing.** `docker-compose.yml` builds the connection string by plain
# interpolation:
#
#   DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/…
#
# The base64 alphabet contains `/`. One `/` in the password ends the authority
# before the `@`, the URL stops parsing, and `apiEnvSchema` (`z.url()`) aborts
# the start with a complaint about **`DATABASE_URL`** — never about the password
# that caused it. With 43 base64 characters that is a coin flip per host, and
# the recovery is not a one-line edit: Postgres has already initialised the role
# with that password.
#
# Hex therefore, not base64: 32 bytes as 64 hex characters carry the same
# entropy and contain nothing a URL, a shell or a YAML file reads as syntax.
#
# `POSTGRES_PASSWORD` is generated here and not in `dev-setup.sh` on purpose:
# locally it is the public placeholder `change-me-locally`, which is *better*
# than a generated one, because the CI image scan needs a value it can tell
# apart from a real secret. On a server the same string would be the credential
# of the database, written down in the repository for everybody.
URL_SAFE_SECRETS=(
  POSTGRES_PASSWORD
)

# 32 random bytes, in the encoding the caller asks for — `base64` for the keys,
# `hex` for anything that ends up inside a URL (see the block above).
#
# The fallback to node is not politeness: `randomBytes` draws from the same OS
# entropy source openssl does, so a machine that can run the API can always
# produce a key, even on a minimal image without openssl.
generate_secret() {
  local encoding="${1:-base64}"
  if command -v openssl > /dev/null 2>&1; then
    if [[ $encoding == 'hex' ]]; then
      openssl rand -hex 32
    else
      openssl rand -base64 32
    fi
  elif command -v node > /dev/null 2>&1; then
    SAMPLE_ENCODING="$encoding" node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString(process.env.SAMPLE_ENCODING))'
  else
    echo "==> Neither openssl nor node found — cannot generate a key." >&2
    echo "    Install one of them, or add the value to $ENV_FILE by hand:" >&2
    echo "      openssl rand -base64 32   # SECRET_BOX_KEY, BACKUP_KEY" >&2
    echo "      openssl rand -hex 32      # POSTGRES_PASSWORD (must be URL-safe)" >&2
    return 1
  fi
}

changed=0
added=()
orphans=()

require_example

# ⚠️ **A development `.env` is not synced against the production template.**
# The mirror image of the check in `scripts/dev-setup.sh`, and the reasoning is
# at `refuse_foreign_env()` in `scripts/lib/env-sync.sh`. Running this against a
# developer's file would carry `IMAGE_PREFIX` and the backup settings into a
# checkout and generate three real secrets into it — quieter than the other
# direction, and just as wrong.
#
# The keys below exist **only** in `.env.example`; the ones both templates share
# would identify nothing.
refuse_foreign_env 'scripts/dev-setup.sh' 'development' \
  SEED_ADMIN_PASSWORD SEED_MEMBER_EMAIL SEED_TENANT_ADMIN_PASSWORD WEB_PORT

create_env_from_example
sync_from_example

generate_into() {
  local key="$1" encoding="$2" secret
  if [[ -n "$(env_value "$key")" ]]; then
    return 0
  fi
  # Through a variable, not inline in the call: a failing command substitution
  # in an argument would be swallowed and would write an empty value, which is
  # exactly the silent half-setup this script exists to prevent.
  secret="$(generate_secret "$encoding")"
  set_env_value "$key" "$secret"
  echo "==> $key: secret generated (the value is not printed)"
  changed=1
}

for key in "${REQUIRED_SECRETS[@]}"; do
  generate_into "$key" base64
done
for key in "${URL_SAFE_SECRETS[@]}"; do
  generate_into "$key" hex
done

# ⚠️ There is deliberately no `DATABASE_URL` and no `FILE_STORAGE_DIR` here any
# more. Compose gives the containers both; the host-side tools
# (`scripts/backup.sh`, `scripts/restore.sh`) work them out from the running
# stack. A third place to write them down was a third place to get them wrong.

report_sync
warn_if_not_ignored

# ⚠️ **There is no hand-fill checklist here any more, and its absence is the
# result.** It used to name `IMAGE_PREFIX`, `APP_VERSION`, `TLS_DOMAIN`,
# `DATABASE_URL` and `FILE_STORAGE_DIR` — five values an operator had to supply
# before anything started. Two of them are gone, the other three have working
# defaults, and after the secrets above are generated the `.env` is complete.
# A checklist that names nothing is better said as one sentence:
echo "==> Ready: docker compose -f docker-compose.prod.yml up -d"
echo "    APP_VERSION=latest runs the newest published build — pin a version"
echo "    from the package overview for a fixed one."
echo "==> Keep SECRET_BOX_KEY and BACKUP_KEY somewhere other than this machine"
echo "    and other than the backup archive."

report_outcome
