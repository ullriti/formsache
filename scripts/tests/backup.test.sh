#!/usr/bin/env bash
#
# backup.test.sh — scenarios for scripts/backup.sh and scripts/restore.sh
# .
#
# **What it is there for.** The two scripts are the only place in this
# project where a *shell script* carries a promise about data — and a
# script that one only reads is a claim. The same build as
# `dev-setup.test.sh` and `ci-docs-only.test.sh`, for the same reason: what
# reads and writes files is checked by letting it read and write
# files.
#
# **What is NOT checked here:** whether a restored installation
# works. That needs a Docker daemon — it runs
# in the CI's `restore` job. Here stands the *creating*: both halves in the
# archive, manifest, retention, encryption, and the cases in which nothing
# may be written.
#
# Needs: a reachable PostgreSQL (DATABASE_URL), pg_dump, openssl.
#
# **Not** checked: the path via `docker compose exec` into a running
# production stack. That needs a daemon and runs in the `restore` job.
#
# Usage: scripts/tests/backup.test.sh
# Exit: 0 = all scenarios fit, 1 = at least one did not.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP="$ROOT/scripts/backup.sh"
RESTORE="$ROOT/scripts/restore.sh"

failures=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() {
  printf '  \033[31m✗\033[0m %s\n' "$1"
  failures=$((failures + 1))
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The credentials come from the `.env`, like with every other tool of this
# repo — and not from a second source invented here.
#
# ⚠️ **Read, not executed.** A `. .env` runs every line as shell;
# the file carries German comments with words like „Organisationsadmin", and the
# shell tries them as a command. The first draft of this test did exactly that
# and reported `Organisationsadmin: command not found` before anything had been checked.
read_env() {
  [ -f "$ROOT/.env" ] || return 0
  grep -m1 "^$1=" "$ROOT/.env" | cut -d= -f2- | sed 's/^"//;s/"$//'
}
: "${DATABASE_URL:=$(read_env DATABASE_URL)}"
: "${SECRET_BOX_KEY:=$(read_env SECRET_BOX_KEY)}"
export DATABASE_URL SECRET_BOX_KEY
: "${DATABASE_URL:?DATABASE_URL fehlt — scripts/dev-setup.sh ausführen}"

# Its own throwaway database: the test creates a table and checks that it
# comes back. Running against the development database would mean emptying it
# with `--clean`.
test_db="formsache_backup_test_$$"
psql "$DATABASE_URL" -qc "create database $test_db" >/dev/null 2>&1 \
  || { printf 'konnte %s nicht anlegen\n' "$test_db" >&2; exit 1; }
trap 'psql "$DATABASE_URL" -qc "drop database if exists '"$test_db"' with (force)" >/dev/null 2>&1; rm -rf "$work"' EXIT
test_url="${DATABASE_URL%/*}/$test_db"

psql "$test_url" -qc 'create table probe (id int primary key, note text)' >/dev/null
psql "$test_url" -qc "insert into probe values (1, 'vor der Sicherung')" >/dev/null

files="$work/files"
mkdir -p "$files/nested"
printf 'ein hochgeladener Inhalt' > "$files/anlage.bin"
printf 'noch einer' > "$files/nested/zweite.bin"
sum_before="$(sha256sum "$files/anlage.bin" | cut -d' ' -f1)"

run_backup() {
  DATABASE_URL="$test_url" FILE_STORAGE_DIR="$files" \
    SECRET_BOX_KEY="${SECRET_BOX_KEY:-test-key}" \
    "$@" 2>"$work/err.log"
}

printf '\n== Eine Option ohne Wert wird gemeldet, nicht ausgesessen ==\n'
# ⚠️ **The case that hung silently.** `--out` without a path made `shift 2` fail;
# without `set -e` `$#` stayed at 1 and `case` hit the same line again —
# endlessly, without a single line of output. The real path there is a cron entry
# with an empty target variable, and there a backup fails that nobody
# misses. `timeout` therefore belongs in these two cases: without it the
# **test suite** would hang in the same place where the script hung.
for flag in --out --keep-days; do
  message="$(timeout 8 env DATABASE_URL="$test_url" FILE_STORAGE_DIR="$files" \
    "$BACKUP" "$flag" 2>&1)"
  status=$?
  if [ "$status" -eq 124 ]; then
    bad "$flag ohne Wert: das Skript hängt (nach 8 s abgeschossen)"
  elif [ "$status" -eq 0 ]; then
    bad "$flag ohne Wert: das Skript meldet Erfolg"
  else
    case "$message" in
      *"$flag braucht"*) ok "$flag ohne Wert wird gemeldet" ;;
      *) bad "$flag ohne Wert scheitert, aber ohne verständliche Meldung: $message" ;;
    esac
  fi
done

printf '\n== Das Archiv trägt beide Hälften ==\n'
out="$work/out"
archive="$(run_backup env BACKUP_DIR="$out" "$BACKUP" --no-encrypt | tail -n 1)"
if [ -f "$archive" ]; then
  ok "Archiv geschrieben: $(basename "$archive")"
else
  # ⚠️ **With the reason, not only with the observation.** A `pg_dump` that
  # fails against a newer server than the runner's would otherwise leave behind
  # only a cross without a hint — the reason is in `err.log` and belongs in
  # the message, not only in the file.
  bad "kein Archiv: $(tail -n 3 "$work/err.log")"
fi

listing="$(tar -tzf "$archive" 2>/dev/null)"
for part in manifest.txt database.dump files.tar.gz; do
  case "$listing" in
    *"$part"*) ok "enthält $part" ;;
    *) bad "im Archiv fehlt $part" ;;
  esac
done

printf '\n== Das Manifest beantwortet die Fragen von vorher ==\n'
tar -xzf "$archive" -C "$work" manifest.txt
for key in created_at app_version migration secret_box_key_fingerprint database_sha256 files_sha256; do
  if grep -q "^$key=" "$work/manifest.txt"; then ok "Manifest nennt $key"; else bad "Manifest ohne $key"; fi
done
# ⚠️ The key itself may stand **nowhere** in the archive (ADR-0017 §2).
if grep -q "^secret_box_key_fingerprint=${SECRET_BOX_KEY:-test-key}$" "$work/manifest.txt"; then
  bad 'das Manifest trägt den SECRET_BOX_KEY im Klartext'
else
  ok 'das Manifest trägt nur den Fingerabdruck, nicht den Schlüssel'
fi

printf '\n== Wiederherstellen bringt Zeilen UND Bytes zurück ==\n'
psql "$test_url" -qc "update probe set note = 'nach der Sicherung'" >/dev/null
rm -rf "$files"
DATABASE_URL="$test_url" FILE_STORAGE_DIR="$files" \
  SECRET_BOX_KEY="${SECRET_BOX_KEY:-test-key}" \
  "$RESTORE" "$archive" --no-encrypt >/dev/null 2>"$work/restore.log" \
  || bad "restore.sh scheiterte: $(tail -n 2 "$work/restore.log")"

restored="$(psql "$test_url" -tAc 'select note from probe where id = 1' 2>/dev/null)"
if [ "$restored" = 'vor der Sicherung' ]; then ok 'die Zeile ist zurück'; else bad "Zeile: „$restored“"; fi

if [ -f "$files/anlage.bin" ] \
  && [ "$(sha256sum "$files/anlage.bin" | cut -d' ' -f1)" = "$sum_before" ]; then
  ok 'die Anlage ist zurück, mit gleicher Prüfsumme'
else
  bad 'die Anlage fehlt oder hat eine andere Prüfsumme'
fi
if [ -f "$files/nested/zweite.bin" ]; then ok 'auch Unterverzeichnisse'; else bad 'Unterverzeichnis fehlt'; fi

printf '\n== Verschlüsselt ist ohne Schlüssel wertlos ==\n'
enc_out="$work/enc"
enc_archive="$(run_backup env BACKUP_DIR="$enc_out" BACKUP_KEY='richtiger-schluessel' "$BACKUP" | tail -n 1)"
if tar -tzf "$enc_archive" >/dev/null 2>&1; then
  bad 'das verschlüsselte Archiv ließ sich ohne Schlüssel auspacken'
else
  ok 'ohne Schlüssel nicht lesbar'
fi

if DATABASE_URL="$test_url" FILE_STORAGE_DIR="$files" BACKUP_KEY='falscher-schluessel' \
  "$RESTORE" "$enc_archive" >/dev/null 2>"$work/wrong.log"; then
  bad 'ein falscher BACKUP_KEY führte trotzdem zu einer Wiederherstellung'
else
  # Aborting cleanly means: with a sentence that names the reason — not with
  # a half-unpacked file that nobody recognizes as broken.
  if grep -q 'BACKUP_KEY' "$work/wrong.log"; then
    ok 'falscher Schlüssel: lesbarer Abbruch'
  else
    bad "falscher Schlüssel: unklarer Abbruch — $(tail -n 1 "$work/wrong.log")"
  fi
fi

printf '\n== Ein falscher SECRET_BOX_KEY wird VORHER gemeldet ==\n'
if DATABASE_URL="$test_url" FILE_STORAGE_DIR="$files" \
  SECRET_BOX_KEY='ein-ganz-anderer-schluessel' \
  "$RESTORE" "$archive" --no-encrypt >/dev/null 2>"$work/keymismatch.log"; then
  bad 'ein fremder SECRET_BOX_KEY lief stillschweigend durch'
else
  if grep -q 'SECRET_BOX_KEY' "$work/keymismatch.log"; then
    ok 'Schlüssel passt nicht: Abbruch mit Begründung'
  else
    bad 'Abbruch ohne Hinweis auf den Schlüssel'
  fi
fi

printf '\n== Die Aufbewahrung räumt auf, ohne je alles zu nehmen ==\n'
keep="$work/keep"
mkdir -p "$keep"
# Two very old archives, both older than the retention period. Exactly the case
# that counts in an emergency: an installation that nobody backed up for four weeks.
touch -d '90 days ago' "$keep/formsache-backup-20260101T000000Z.tar.gz"
touch -d '80 days ago' "$keep/formsache-backup-20260201T000000Z.tar.gz"
fresh="$(run_backup env BACKUP_DIR="$keep" BACKUP_KEEP_DAYS=30 "$BACKUP" --no-encrypt | tail -n 1)"
# Both old ones lie beyond the retention period and are **not** the youngest —
# they have to go, and the new one has to be there.
if [ ! -f "$keep/formsache-backup-20260101T000000Z.tar.gz" ] \
  && [ ! -f "$keep/formsache-backup-20260201T000000Z.tar.gz" ]; then
  ok 'Archive über der Frist wurden abgeräumt'
else
  bad 'ein Archiv über der Frist blieb liegen'
fi
if [ -f "$fresh" ]; then ok 'das frische Archiv steht'; else bad 'das frische Archiv fehlt'; fi
# The actual promise, and it hangs on the **order**: cleaning up happens
# only once the new archive is in place. After no run is the directory empty.
if [ "$(find "$keep" -name 'formsache-backup-*' | wc -l)" -ge 1 ]; then
  ok 'nach dem Aufräumen bleibt mindestens ein Archiv'
else
  bad 'das Aufräumen hat alles genommen'
fi

# And the case without a new archive: only old ones, none may disappear.
lonely="$work/lonely"
mkdir -p "$lonely"
touch -d '90 days ago' "$lonely/formsache-backup-20260101T000000Z.tar.gz"
BACKUP_DIR="$lonely" BACKUP_KEEP_DAYS=30 DATABASE_URL='postgres://nirgends/x' \
  FILE_STORAGE_DIR="$files" BACKUP_KEY=x "$BACKUP" >/dev/null 2>&1
if [ -f "$lonely/formsache-backup-20260101T000000Z.tar.gz" ]; then
  ok 'ein gescheiterter Lauf räumt nichts ab'
else
  bad 'ein gescheiterter Lauf hat die einzige Sicherung gelöscht'
fi

printf '\n== Woher die Verbindung kommt, wenn niemand sie hinschreibt ==\n'
# ⚠️ **The point of the whole exercise:** `DATABASE_URL` and `FILE_STORAGE_DIR`
# are no longer in the production template. So the script has to find both
# itself — and a set variable must nevertheless always win.
#
# `COMPOSE_PROD_FILE` points into the void in these cases so that "no running
# stack" is measured and not the mood of the machine the test runs on.
creds="${test_url#*://}"
pg_user="${creds%%:*}"
pg_rest="${creds#*:}"
pg_pass="${pg_rest%%@*}"
pg_hostport="${pg_rest#*@}"
pg_hostport="${pg_hostport%%/*}"
pg_host="${pg_hostport%%:*}"
pg_port="${pg_hostport#*:}"
[ "$pg_port" = "$pg_hostport" ] && pg_port=5432

derived="$(env -u DATABASE_URL COMPOSE_PROD_FILE=/nirgends/prod.yml \
  POSTGRES_USER="$pg_user" POSTGRES_PASSWORD="$pg_pass" POSTGRES_DB="$test_db" \
  POSTGRES_HOST="$pg_host" POSTGRES_PORT="$pg_port" \
  FILE_STORAGE_DIR="$files" BACKUP_DIR="$work/derived" \
  "$BACKUP" --no-encrypt 2>"$work/derived.log" | tail -n 1)"
if [ -n "$derived" ] && [ -f "$derived" ]; then
  ok 'ohne DATABASE_URL wird sie aus POSTGRES_USER/PASSWORD/DB gebaut'
else
  bad "die abgeleitete Verbindung trug nicht: $(tail -n 2 "$work/derived.log")"
fi

# A set `DATABASE_URL` wins — here against POSTGRES_* values that point
# nowhere. If the derivation took precedence, this run would fail.
if DATABASE_URL="$test_url" COMPOSE_PROD_FILE=/nirgends/prod.yml \
  POSTGRES_USER=falsch POSTGRES_PASSWORD=falsch POSTGRES_DB=gibtsnicht \
  POSTGRES_HOST=nirgends FILE_STORAGE_DIR="$files" BACKUP_DIR="$work/explicit" \
  "$BACKUP" --no-encrypt >/dev/null 2>"$work/explicit.log"; then
  ok 'eine gesetzte DATABASE_URL gewinnt über die Ableitung'
else
  bad "die gesetzte DATABASE_URL verlor: $(tail -n 2 "$work/explicit.log")"
fi

# And if both are missing: a message that says what to do — not a
# `pg_dump` that runs against the system user and backs up something or other.
if env -u DATABASE_URL -u POSTGRES_USER -u POSTGRES_PASSWORD -u POSTGRES_DB \
  COMPOSE_PROD_FILE=/nirgends/prod.yml FILE_STORAGE_DIR="$files" \
  BACKUP_DIR="$work/nourl" "$BACKUP" --no-encrypt >/dev/null 2>"$work/nourl.log"; then
  bad 'ohne jede Verbindungsangabe wurde trotzdem etwas gesichert'
else
  if grep -q 'POSTGRES_USER' "$work/nourl.log"; then
    ok 'ohne Verbindungsangabe: Abbruch, der die Variablen nennt'
  else
    bad "Abbruch ohne verwertbaren Hinweis: $(tail -n 1 "$work/nourl.log")"
  fi
fi

# The same for the attachments: without a variable and without a stack there is
# no path to guess. A default path here would mean: a backup without attachments
# that looks like a complete one.
if env -u FILE_STORAGE_DIR COMPOSE_PROD_FILE=/nirgends/prod.yml \
  DATABASE_URL="$test_url" BACKUP_DIR="$work/nofiles" \
  "$BACKUP" --no-encrypt >/dev/null 2>"$work/nofiles.log"; then
  bad 'ohne FILE_STORAGE_DIR wurde trotzdem gesichert'
else
  if grep -q 'FILE_STORAGE_DIR' "$work/nofiles.log"; then
    ok 'ohne Upload-Verzeichnis: Abbruch, der es benennt'
  else
    bad "Abbruch ohne verwertbaren Hinweis: $(tail -n 1 "$work/nofiles.log")"
  fi
fi

printf '\n== Was nicht geschrieben werden darf ==\n'
if DATABASE_URL="$test_url" FILE_STORAGE_DIR="$files" BACKUP_KEY=x \
  "$BACKUP" --out /proc/nichts-hier >/dev/null 2>&1; then
  bad 'ein unbeschreibbares Ziel wurde als Erfolg gemeldet'
else
  ok 'unbeschreibbares Ziel: Abbruch'
fi

if DATABASE_URL='postgres://nirgends:5432/x' FILE_STORAGE_DIR="$files" BACKUP_KEY=x \
  BACKUP_DIR="$work/nodb" "$BACKUP" >/dev/null 2>&1; then
  bad 'eine unerreichbare Datenbank wurde als Erfolg gemeldet'
else
  ok 'unerreichbare Datenbank: Abbruch'
fi
if [ -z "$(find "$work/nodb" -name 'formsache-backup-*' 2>/dev/null)" ]; then
  ok 'und es blieb kein halbes Archiv liegen'
else
  bad 'ein halbes Archiv blieb liegen'
fi

if DATABASE_URL="$test_url" FILE_STORAGE_DIR="$files" BACKUP_DIR="$work/nokey" \
  "$BACKUP" >/dev/null 2>&1; then
  bad 'ohne BACKUP_KEY wurde unverschlüsselt gesichert'
else
  ok 'ohne BACKUP_KEY: Abbruch statt Klartext'
fi

printf '\n== Ein Kennwort mit Sonderzeichen trägt durch ==\n'
# ⚠️ **The case that looked like a host name.** `POSTGRES_PASSWORD=s3cr@t`
# landed raw in the URL; `pg_env` split at the **first** `@` and set
# `PGHOST=t`. The backup failed with „could not translate host name", and
# nobody hit on the password. Generated passwords are hex — that only saves
# the normal case, and an operator may set their own.
odd_role="formsache_odd_$$"
odd_pass='s3cr@t/x:y%z'
# Via stdin, not via `-c`: even a throwaway password does not belong in
# `/proc/<pid>/cmdline` — the same rule that gives rise to `pg_env` in the first place.
if psql "$DATABASE_URL" -q -f - >/dev/null 2>&1 <<SQL
create role $odd_role login password '$odd_pass';
create database $odd_role owner $odd_role;
SQL
then
  trap 'psql "$DATABASE_URL" -qc "drop database if exists '"$test_db"' with (force)" >/dev/null 2>&1;
        psql "$DATABASE_URL" -qc "drop database if exists '"$odd_role"' with (force)" >/dev/null 2>&1;
        psql "$DATABASE_URL" -qc "drop role if exists '"$odd_role"'" >/dev/null 2>&1;
        rm -rf "$work"' EXIT
  odd_archive="$(env -u DATABASE_URL COMPOSE_PROD_FILE=/nirgends/prod.yml \
    POSTGRES_USER="$odd_role" POSTGRES_PASSWORD="$odd_pass" POSTGRES_DB="$odd_role" \
    POSTGRES_HOST="$pg_host" POSTGRES_PORT="$pg_port" \
    FILE_STORAGE_DIR="$files" BACKUP_DIR="$work/odd" \
    "$BACKUP" --no-encrypt 2>"$work/odd.log" | tail -n 1)"
  if [ -n "$odd_archive" ] && [ -f "$odd_archive" ]; then
    ok 'ein Kennwort mit @ / : % wird gesichert statt als Hostname gelesen'
  else
    bad "das Kennwort mit Sonderzeichen trug nicht: $(tail -n 2 "$work/odd.log")"
  fi
else
  bad "die Rolle mit Sonderzeichen-Kennwort ließ sich nicht anlegen — Fall ungeprüft"
fi

# And the reverse, directly at the library: it is built percent-encoded,
# it is split at the **last** `@` — even with a hand-written URL
# in which the password carries a raw `@`.
roundtrip="$(env -u DATABASE_URL bash -c '
  ROOT="'"$ROOT"'"; die() { printf "%s\n" "$1" >&2; exit 1; }
  # shellcheck source=/dev/null
  source "$ROOT/scripts/lib/stack.sh"
  POSTGRES_USER="form@sache" POSTGRES_PASSWORD="s3cr@t/x:y" POSTGRES_DB=formsache \
    POSTGRES_HOST=db.example POSTGRES_PORT=5433 derive_database_url
  printf "%s\n" "$DATABASE_URL"
  pg_env "$DATABASE_URL"
  printf "%s|%s|%s|%s|%s\n" "$PGUSER" "$PGPASSWORD" "$PGHOST" "$PGPORT" "$PGDATABASE"
  unset PGUSER PGPASSWORD
  pg_env "postgresql://u:s3cr@t@127.0.0.1:5432/db"
  printf "%s|%s|%s\n" "$PGUSER" "$PGPASSWORD" "$PGHOST"
' 2>&1)"
built="$(printf '%s\n' "$roundtrip" | sed -n 1p)"
parsed="$(printf '%s\n' "$roundtrip" | sed -n 2p)"
raw="$(printf '%s\n' "$roundtrip" | sed -n 3p)"
case "$built" in
  *'%40'*) ok 'die gebaute URL kodiert das @ des Kennworts' ;;
  *) bad "die gebaute URL kodiert nicht: $built" ;;
esac
if [ "$parsed" = 'form@sache|s3cr@t/x:y|db.example|5433|formsache' ]; then
  ok 'und zerlegt sie zu genau denselben Werten zurück'
else
  bad "die Zerlegung ergab: $parsed"
fi
if [ "$raw" = 'u|s3cr@t|127.0.0.1' ]; then
  ok 'eine URL mit rohem @ im Kennwort wird am letzten @ getrennt'
else
  bad "rohes @ im Kennwort: $raw"
fi

printf '\n== Das gebrauchte Werkzeug wird geprüft, nicht immer pg_dump ==\n'
# ⚠️ `restore.sh` needs `pg_restore`, not `pg_dump`. Checking for `pg_dump`
# unconditionally rejected a host with only `pg_restore` for no reason — and let
# the reverse case become noticeable only in the middle of the restore.
missing_tool() {
  # `command` as a function shadows the builtin: this way exactly one tool is
  # missing, without the test having to tinker with the machine's PATH.
  env -u DATABASE_URL bash -c '
    ROOT="'"$ROOT"'"; die() { printf "die: %s\n" "$1" >&2; exit 1; }
    # shellcheck source=/dev/null
    source "$ROOT/scripts/lib/stack.sh"
    fehlt="'"$1"'"
    command() { [ "$2" = "$fehlt" ] && return 1; builtin command "$@"; }
    DATABASE_URL="'"$test_url"'" resolve_database_access '"$2"' && printf "durch\n"
  ' 2>&1
}
case "$(missing_tool pg_dump pg_restore)" in
  *durch*) ok 'ein Host ohne pg_dump darf einspielen' ;;
  *) bad 'ohne pg_dump wird das Einspielen abgewiesen' ;;
esac
case "$(missing_tool pg_restore pg_dump)" in
  *durch*) ok 'und ein Host ohne pg_restore darf sichern' ;;
  *) bad 'ohne pg_restore wird das Sichern abgewiesen' ;;
esac
case "$(missing_tool pg_dump pg_dump)" in
  *'pg_dump nicht gefunden'*) ok 'fehlt das wirklich gebrauchte Werkzeug: Abbruch, der es nennt' ;;
  *) bad 'ein fehlendes pg_dump wurde beim Sichern übergangen' ;;
esac
# And both scripts ask for what they really use.
grep -q 'resolve_database_access pg_dump' "$ROOT/scripts/backup.sh" \
  && ok 'backup.sh verlangt pg_dump' || bad 'backup.sh verlangt nicht pg_dump'
grep -q 'resolve_database_access pg_restore' "$ROOT/scripts/restore.sh" \
  && ok 'restore.sh verlangt pg_restore' || bad 'restore.sh verlangt nicht pg_restore'

printf '\n== Der Zustand einer Wiederherstellung: api aus, db an ==\n'
# ⚠️ **The case that no scenario has hit so far.** The cases above set
# `COMPOSE_PROD_FILE` into the void **and** `DATABASE_URL`/`FILE_STORAGE_DIR` —
# following the manual, however, the operator has neither the one nor the other:
# they have a `.env` and a stack of which only `db` runs.
#
# Docker does not exist here (no daemon), so a stand-in is in the PATH that
# answers exactly the questions `scripts/lib/stack.sh` asks. What is
# **not** evidenced by that: that a real `docker compose exec` behaves this way.
# That is measured by the CI's `restore` job.
stub_bin="$work/bin"
mkdir -p "$stub_bin"
stack_volume="$(grep -oE "^STACK_FILES_VOLUME='[a-z0-9-]+'" "$ROOT/scripts/lib/stack.sh" | cut -d\' -f2)"
if [ -n "$stack_volume" ] && grep -qE "^  $stack_volume:$" "$ROOT/docker-compose.prod.yml"; then
  ok "stack.sh und docker-compose.prod.yml nennen dasselbe Volume ($stack_volume)"
else
  bad "das Volume aus stack.sh ('$stack_volume') steht nicht in docker-compose.prod.yml"
fi

cat > "$stub_bin/docker" <<'STUB'
#!/usr/bin/env bash
# Docker stand-in for this test: no daemon, only answers. What may be asked
# stands in scripts/lib/stack.sh — this stand-in cannot do more.
set -uo pipefail
case "${1:-}" in
  compose)
    shift
    [ "${1:-}" = '-f' ] && shift 2
    sub="${1:-}"; shift
    case "$sub" in
      ps)
        case "${2:-}" in
          db) [ -n "${STUB_DB_ID:-}" ] && printf '%s\n' "$STUB_DB_ID" ;;
          api) [ -n "${STUB_API_ID:-}" ] && printf '%s\n' "$STUB_API_ID" ;;
        esac ;;
      exec)
        [ "${1:-}" = '-T' ] && shift
        shift                       # the service name; what is asked is always `db`
        exec "$@" ;;                # PGHOST/PGPORT/PGPASSWORD are in the environment
    esac ;;
  inspect)
    shift
    fmt=''
    [ "${1:-}" = '-f' ] && { fmt="$2"; shift 2; }
    case "$fmt" in
      *State.Running*) printf 'true\n' ;;
      *compose.project*) printf '%s\n' "${STUB_PROJECT:-}" ;;
      *Mounts*) printf '%s\n' "${STUB_MOUNT_NAME:-}" ;;
    esac ;;
  volume)
    shift
    case "${1:-}" in
      ls)
        args="$*"
        case "$args" in *"project=${STUB_PROJECT:-kein}"*) ;; *) exit 0 ;; esac
        case "$args" in *"volume=${STUB_VOLUME_KEY:-kein}"*) ;; *) exit 0 ;; esac
        printf '%s\n' "${STUB_VOLUME_NAME:-}" ;;
      inspect) printf '%s\n' "${STUB_VOLUME_PATH:-}" ;;
    esac ;;
esac
STUB
chmod +x "$stub_bin/docker"

fake_prod="$work/prod.yml"
: > "$fake_prod"
stub_volume_path="$work/volume-files"
mkdir -p "$stub_volume_path"

# The stack as it stands after `up -d db`: `db` runs, `api` does not, and the
# upload volume is found via the compose labels instead of via the container.
stack_up_db() {
  env -u DATABASE_URL -u FILE_STORAGE_DIR \
    PATH="$stub_bin:$PATH" COMPOSE_PROD_FILE="$fake_prod" \
    STUB_DB_ID=db-container STUB_PROJECT=formsache \
    STUB_VOLUME_KEY="$stack_volume" STUB_VOLUME_NAME=formsache_api-files \
    STUB_VOLUME_PATH="$stub_volume_path" \
    POSTGRES_USER="$pg_user" POSTGRES_DB="$test_db" \
    PGHOST="$pg_host" PGPORT="$pg_port" PGUSER="$pg_user" PGPASSWORD="$pg_pass" \
    "$@"
}

# 1. The stack is all the way down — exactly what a `down` leaves behind.
psql "$test_url" -qc "update probe set note = 'unberührt'" >/dev/null
if env -u DATABASE_URL -u FILE_STORAGE_DIR \
  PATH="$stub_bin:$PATH" COMPOSE_PROD_FILE="$fake_prod" \
  POSTGRES_USER="$pg_user" POSTGRES_PASSWORD="$pg_pass" POSTGRES_DB="$test_db" \
  POSTGRES_HOST="$pg_host" POSTGRES_PORT="$pg_port" \
  "$RESTORE" "$archive" --no-encrypt >/dev/null 2>"$work/down.log"; then
  bad 'mit ganz abgeschaltetem Stack meldete die Wiederherstellung Erfolg'
else
  if grep -q 'up -d db' "$work/down.log"; then
    ok 'Stack ganz unten: Abbruch, der den Datenbankdienst zu starten verlangt'
  else
    bad "Stack ganz unten: Abbruch ohne brauchbaren Hinweis — $(tail -n 2 "$work/down.log")"
  fi
fi

# 2. `api` is still running — `pg_restore --clean` would pull the tables away from it.
if stack_up_db env STUB_API_ID=api-container STUB_MOUNT_NAME=formsache_api-files \
  "$RESTORE" "$archive" --no-encrypt >/dev/null 2>"$work/apiup.log"; then
  bad 'die Wiederherstellung lief, während der api-Container läuft'
else
  if grep -q 'stop api web' "$work/apiup.log"; then
    ok 'laufender api: Abbruch, der den Weg nennt'
  else
    bad "laufender api: Abbruch ohne den Weg — $(tail -n 2 "$work/apiup.log")"
  fi
fi
if [ "$(psql "$test_url" -tAc 'select note from probe where id = 1')" = 'unberührt' ]; then
  ok '… und die Datenbank blieb dabei unberührt'
else
  bad 'der Abbruch kam zu spät — die Datenbank wurde schon angefasst'
fi

# 3. The state the manual establishes: only `db`. That has to run through.
rm -rf "$stub_volume_path"
if stack_up_db "$RESTORE" "$archive" --no-encrypt >/dev/null 2>"$work/onlydb.log"; then
  ok 'nur db oben: die Wiederherstellung läuft durch'
else
  bad "nur db oben: gescheitert — $(tail -n 3 "$work/onlydb.log")"
fi
if [ "$(psql "$test_url" -tAc 'select note from probe where id = 1')" = 'vor der Sicherung' ]; then
  ok '… die Zeile ist zurück'
else
  bad '… die Zeile kam nicht zurück'
fi
if [ -f "$stub_volume_path/anlage.bin" ]; then
  ok '… und die Anlage liegt im Volume, das ohne api gefunden wurde'
else
  bad '… die Anlage landete nicht im Volume des Stacks'
fi

printf '\n== Ein leerer Migrationsstand wird gesagt ==\n'
# ⚠️ It drops out silently as soon as `psql` is missing or `POSTGRES_USER`
# deviates — the real path there is a cron without a loaded `.env`. The manifest
# would then write „unbekannt", and during the restore exactly the piece of
# information that counts would be missing.
# This throwaway database has no `_prisma_migrations`, so the case is real.
migless="$(stack_up_db env BACKUP_DIR="$work/migless" "$BACKUP" --no-encrypt \
  2>"$work/migless.log" | tail -n 1)"
if [ -n "$migless" ] && [ -f "$migless" ]; then
  ok 'ohne Migrationsstand wird trotzdem gesichert (ein Archiv schlägt keines)'
else
  bad "der Lauf ohne _prisma_migrations schrieb kein Archiv: $(tail -n 2 "$work/migless.log")"
fi
if grep -q 'WARNUNG' "$work/migless.log"; then
  ok '… aber mit einer Warnung, nicht stillschweigend'
else
  bad '… und schwieg über den fehlenden Migrationsstand'
fi
tar -xzf "$migless" -C "$work/migless" manifest.txt 2>/dev/null
if grep -q '^migration=unbekannt$' "$work/migless/manifest.txt" 2>/dev/null; then
  ok '… das Manifest sagt „unbekannt", statt die Zeile leer zu lassen'
else
  bad '… das Manifest lässt den Migrationsstand leer'
fi
if DATABASE_URL="$test_url" FILE_STORAGE_DIR="$files" \
  "$RESTORE" "$migless" --no-encrypt 2>&1 >/dev/null | grep -q 'WARNUNG'; then
  ok '… und das Einspielen sagt es noch einmal, bevor es beginnt'
else
  bad '… beim Einspielen blieb der fehlende Migrationsstand unerwähnt'
fi

printf '\n'
if [ "$failures" -eq 0 ]; then
  printf '\033[32mOK: alle Szenarien passten.\033[0m\n'
  exit 0
fi
printf '\033[31m%d Szenario(s) fehlgeschlagen.\033[0m\n' "$failures"
exit 1
