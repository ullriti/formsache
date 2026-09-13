#!/usr/bin/env bash
#
# stack.sh — where the tools on the host find the database and the uploads.
#
# `backup.sh` and `restore.sh` run **next to** the containers, not inside them.
# The `.env` of a production installation does not tell them how to reach either
# of the two — the production stack publishes no database port, and the path
# behind the upload volume belongs to Docker. So they determine it:
#
#   1. an explicitly set variable always wins,
#   2. otherwise the running compose stack,
#   3. otherwise the values compose builds the connection from.
#
# ⚠️ **Authoritative is the `db` service, not the whole stack.** A restore
# brings up exactly one service (`up -d db`) and leaves `api` and `web` down —
# this path has to yield both.
#
# This file is sourced, never executed. The caller sets `ROOT` and a function
# `die()` beforehand.

# The production stack, for `docker compose … exec`. Overridable so that the
# script tests can point at a throwaway file.
COMPOSE_PROD_FILE="${COMPOSE_PROD_FILE:-$ROOT/docker-compose.prod.yml}"

# The volume key of the uploads in `docker-compose.prod.yml`. It lives here
# because the volume has to be found even without a running `api`;
# `scripts/tests/backup.test.sh` holds both places against each other.
STACK_FILES_VOLUME='api-files'

# The container ID of a service of the stack, or failure. No Docker, no file,
# no container — each of these means "then on the host instead".
stack_service_id() {
  command -v docker > /dev/null 2>&1 || return 1
  [ -f "$COMPOSE_PROD_FILE" ] || return 1
  local id
  id="$(docker compose -f "$COMPOSE_PROD_FILE" ps -q "$1" 2> /dev/null)" || return 1
  [ -n "$id" ] || return 1
  printf '%s' "$id"
}

# Is this service running **right now**? Not the same as "there is a container":
# depending on the compose version, `ps -q` also names stopped ones, and a
# stopped `api` answers no `exec`.
stack_service_running() {
  local id
  id="$(stack_service_id "$1")" || return 1
  [ "$(docker inspect -f '{{.State.Running}}' "$id" 2> /dev/null)" = 'true' ]
}

# A command in the container of a service. `-T`, because no terminal is attached
# here: without the flag the data stream would get control characters and the
# archive would be broken.
stack_exec() {
  local service="$1"
  shift
  docker compose -f "$COMPOSE_PROD_FILE" exec -T "$service" "$@"
}

# Percent encoding, **byte-wise** (`LC_ALL=C`) — otherwise an umlaut would fall
# apart into half characters. Without it a password like `s3cr@t` would split the
# URL at the wrong place, and the message spoke of an unknown host name.
url_encode() {
  local LC_ALL=C s="$1" out='' i c
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [A-Za-z0-9._~-]) out="$out$c" ;;
      *) out="$out$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

# The opposite direction, for `pg_env`. Double the backslashes first: `printf %b`
# would otherwise read `\t` as a tab.
url_decode() {
  local s="${1//\\/\\\\}"
  printf '%b' "${s//%/\\x}"
}

# `DATABASE_URL`, if it is not set anyway: from the same three values compose
# builds it from as well. `POSTGRES_HOST`/`POSTGRES_PORT` are there for the case
# that the database runs somewhere else than the tool.
derive_database_url() {
  [ -n "${DATABASE_URL:-}" ] && return 0
  [ -n "${POSTGRES_USER:-}" ] && [ -n "${POSTGRES_PASSWORD:-}" ] && [ -n "${POSTGRES_DB:-}" ] || return 1
  DATABASE_URL="postgresql://$(url_encode "$POSTGRES_USER"):$(url_encode "$POSTGRES_PASSWORD")@${POSTGRES_HOST:-127.0.0.1}:${POSTGRES_PORT:-5432}/${POSTGRES_DB}"
  export DATABASE_URL
  return 0
}

# The name of the upload volume. From the `api` container, if it exists —
# otherwise via the labels compose leaves on the volume itself. The second path
# is the restore case: there **only** `db` runs.
stack_files_volume_name() {
  local id name project
  if id="$(stack_service_id api)"; then
    name="$(docker inspect -f \
      '{{range .Mounts}}{{if eq .Destination "/var/lib/formsache/files"}}{{.Name}}{{end}}{{end}}' \
      "$id" 2> /dev/null)"
    [ -n "$name" ] && {
      printf '%s' "$name"
      return 0
    }
  fi
  id="$(stack_service_id db)" || return 1
  project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' \
    "$id" 2> /dev/null)" || return 1
  [ -n "$project" ] || return 1
  name="$(docker volume ls -q \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.volume=$STACK_FILES_VOLUME" 2> /dev/null | head -n 1)"
  [ -n "$name" ] || return 1
  printf '%s' "$name"
}

# The path behind the upload volume. Docker assigns it, so Docker is asked
# instead of writing it down a second time.
derive_file_storage_dir() {
  [ -n "${FILE_STORAGE_DIR:-}" ] && return 0
  local name path
  name="$(stack_files_volume_name)" || return 1
  path="$(docker volume inspect -f '{{.Mountpoint}}' "$name" 2> /dev/null)" || return 1
  [ -n "$path" ] || return 1
  FILE_STORAGE_DIR="$path"
  export FILE_STORAGE_DIR
  return 0
}

# ⚠️ **The connection data goes through the environment, not through arguments.**
# `pg_dump --dbname "$DATABASE_URL"` put the password into `/proc/<pid>/cmdline`
# — without `hidepid` readable by every local user. The Postgres tools read
# `PG*` by themselves.
pg_env() {
  local url="$1"
  local rest="${url#*://}"
  # The split happens at the **last** `@`, not at the first one: a password may
  # itself carry one. Percent sequences are resolved, as libpq does too.
  local creds="${rest%@*}"
  local hostpart="${rest##*@}"
  # Without `@` there are no credentials in the URL — then everything stays at
  # libpq's default behavior (socket, system user).
  if [ "$creds" = "$rest" ]; then
    hostpart="$rest"
  else
    PGUSER="$(url_decode "${creds%%:*}")"
    [ "${creds#*:}" = "$creds" ] || PGPASSWORD="$(url_decode "${creds#*:}")"
    export PGUSER
    [ -n "${PGPASSWORD:-}" ] && export PGPASSWORD
  fi
  local dbpart="${hostpart#*/}"
  PGDATABASE="${dbpart%%\?*}"
  local hostport="${hostpart%%/*}"
  PGHOST="${hostport%%:*}"
  if [ "${hostport#*:}" = "$hostport" ]; then PGPORT=5432; else PGPORT="${hostport#*:}"; fi
  export PGDATABASE PGHOST PGPORT
}

# Determines by which path the database is addressed, and sets `STACK_DB_MODE`
# to `compose` or `host`.
#
# `compose` wins if the `db` service is running: there the database is reachable
# without a published port, and the `pg_dump` inside the container is guaranteed
# to be as new as the server. Otherwise the host path via the URL.
#
# `$@`: the tools the caller needs on the **host** — `pg_dump` when backing up,
# `pg_restore` when restoring. Checking for `pg_dump` unconditionally rejected a
# host with `pg_restore` for no reason and let the reverse case blow up only in
# the middle of the restore.
resolve_database_access() {
  if [ -z "${DATABASE_URL:-}" ] && stack_service_running db; then
    STACK_DB_MODE='compose'
    : "${POSTGRES_USER:=formsache}"
    : "${POSTGRES_DB:=formsache}"
    export POSTGRES_USER POSTGRES_DB
    return 0
  fi
  STACK_DB_MODE='host'
  derive_database_url || die 'weder DATABASE_URL noch POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB gesetzt — .env laden oder den Datenbankdienst starten (docker compose -f docker-compose.prod.yml up -d db)'
  pg_env "$DATABASE_URL"
  local tool
  for tool in "$@"; do
    command -v "$tool" > /dev/null || die "$tool nicht gefunden"
  done
  return 0
}

# The same for the uploads: a set variable, otherwise the volume of the stack.
# `db` is enough for that — the path via the labels of the volume needs no
# running `api`, and that is exactly the state of a restore.
resolve_file_storage() {
  derive_file_storage_dir || die 'FILE_STORAGE_DIR ist nicht gesetzt und ließ sich nicht ermitteln — Variable setzen oder den Datenbankdienst starten (docker compose -f docker-compose.prod.yml up -d db)'
}

# Back up the database, to stdout. In the container case via `compose exec`, so
# that neither a port nor a suitably old client on the host is needed.
stack_pg_dump() {
  if [ "$STACK_DB_MODE" = 'compose' ]; then
    stack_exec db pg_dump -Fc --no-owner --no-privileges \
      -U "$POSTGRES_USER" -d "$POSTGRES_DB"
  else
    pg_dump -Fc --no-owner --no-privileges
  fi
}

# Restore an archive, from stdin.
stack_pg_restore() {
  if [ "$STACK_DB_MODE" = 'compose' ]; then
    stack_exec db pg_restore --clean --if-exists --no-owner --no-privileges \
      -U "$POSTGRES_USER" -d "$POSTGRES_DB"
  else
    pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$PGDATABASE"
  fi
}

# A single query, without header row and without frame.
stack_psql_value() {
  if [ "$STACK_DB_MODE" = 'compose' ]; then
    stack_exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"
  else
    psql -tAc "$1"
  fi
}
